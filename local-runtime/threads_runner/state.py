"""Durable single-writer state with request history and no daily request cap."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path, PureWindowsPath
import sqlite3
import time
import uuid

APP_ID = 0x544D4D31
SCHEMA_VERSION = 1
LEGACY_POLICY = {"name": "one-file-pilot-v1", "requests_per_24h": 1, "max_redirects": 0,
          "file_wait_seconds": [3, 10], "round_files": [35, 45],
          "round_wait_seconds": [60, 120], "account_wait_seconds": [10, 30]}
POLICY = {key: value for key, value in LEGACY_POLICY.items() if key != "requests_per_24h"}
POLICY["name"] = "local-download-v2"


def supported_policy(value):
    return value in (POLICY, LEGACY_POLICY)


class StateError(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code, self.message = code, message


def safe_path(root: Path, relative: str, *, require_file=False) -> Path:
    rel = Path(relative)
    if (rel.is_absolute() or rel.drive or rel.root or PureWindowsPath(relative).drive or
            not rel.parts or any(x in ("..", ".") or ":" in x for x in rel.parts) or "\\" in relative):
        raise StateError("unsafe_path", "상대 경로가 자료 폴더 밖을 가리킵니다.")
    path = root / rel
    for part in [path, *path.parents]:
        if part == root:
            break
        if part.is_symlink():
            raise StateError("symlink", "자료 내부 심볼릭 링크는 지원하지 않습니다.")
    if require_file and (not path.is_file() or path.stat().st_nlink != 1):
        raise StateError("invalid_file", "단일 일반 파일이 필요합니다.")
    return path


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def sync_directory(path: Path):
    if os.name != "nt":
        descriptor = os.open(path, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def durable_json(path: Path, value):
    with path.open("x", encoding="utf-8") as f:
        json.dump(value, f, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())


class State:
    def __init__(self, root: Path, *, clock=time.time, lock_token=None):
        root = Path(root)
        if not root.is_absolute() or root.is_symlink() or not root.is_dir():
            raise StateError("invalid_root", "기존 수집 폴더의 절대 경로가 필요합니다.")
        self.root = root.resolve()
        for parent in [self.root, *self.root.parents]:
            if (parent / ".codex-plugin/plugin.json").is_file():
                raise StateError("plugin_storage", "플러그인 외부의 사용자 자료 폴더가 필요합니다.")
        self.state_dir = safe_path(self.root, "state")
        self.media_dir = safe_path(self.root, "media")
        self.lock = safe_path(self.root, "_work/collector.lock")
        self.clock = clock
        self.db = None
        self.token = uuid.uuid4().hex
        self.owns_lock = False
        self.borrowed_token = lock_token
        self.lock_data = None

    def __enter__(self):
        self.lock.parent.mkdir(exist_ok=True)
        if self.borrowed_token:
            safe_path(self.root, "_work/collector.lock", require_file=True)
            try:
                self.lock_data = json.loads(self.lock.read_text())
            except (ValueError, OSError) as exc:
                raise StateError("busy", "수집 잠금 인계를 검증할 수 없습니다.") from exc
            if (self.lock_data.get("token") != self.borrowed_token or self.lock_data.get("owner") != "collector" or
                    not self.lock_data.get("run_id")):
                raise StateError("busy", "수집 잠금 토큰·실행 정보가 맞지 않습니다.")
        else:
            try:
                durable_json(self.lock, {"owner": "download-runner", "token": self.token, "pid": os.getpid()})
            except FileExistsError as exc:
                raise StateError("busy", "수집 또는 다운로드 잠금이 있습니다. 자동 제거하지 않습니다.") from exc
            self.owns_lock = True
        try:
            if list(self.root.glob("~$*.xlsx")) or list((self.root / "results").rglob("~$*.xlsx")):
                raise StateError("excel_busy", "Excel을 닫고 다시 진행하세요.")
            self._open()
            return self
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def __exit__(self, *args):
        if self.db is not None:
            self.db.close()
            self.db = None
        if self.owns_lock:
            try:
                if not self.lock.is_symlink() and json.loads(self.lock.read_text())["token"] == self.token:
                    self.lock.unlink()
            except (OSError, ValueError, KeyError):
                pass
            self.owns_lock = False

    def _open(self):
        db_path = safe_path(self.root, "state/state.db")
        marker = safe_path(self.root, "media/.library.json")
        exists = db_path.exists()
        if not exists:
            if (self.state_dir.exists() and any(self.state_dir.iterdir())) or (
                    self.media_dir.exists() and any(self.media_dir.iterdir())):
                raise StateError("library_recovery_required", "기존 자료와 연결된 DB가 필요합니다. 초기화하지 않았습니다.")
            self.state_dir.mkdir(exist_ok=True)
            self.media_dir.mkdir(exist_ok=True)
            with db_path.open("xb"):
                pass
        else:
            safe_path(self.root, "state/state.db", require_file=True)
            if not marker.is_file():
                raise StateError("library_recovery_required", "미디어 식별 파일이 없습니다.")
        for name in ("state.db-wal", "state.db-shm", "state.db-journal"):
            p = safe_path(self.root, "state/" + name)
            if p.exists() and (not p.is_file() or p.stat().st_nlink != 1):
                raise StateError("invalid_database", "SQLite 부속 파일이 올바르지 않습니다.")
        try:
            self.db = sqlite3.connect(db_path, timeout=0)
            self.db.row_factory = sqlite3.Row
            if exists:
                if (self.db.execute("PRAGMA application_id").fetchone()[0] != APP_ID or
                        self.db.execute("PRAGMA user_version").fetchone()[0] != SCHEMA_VERSION or
                        self.db.execute("PRAGMA quick_check").fetchone()[0] != "ok"):
                    raise StateError("invalid_database", "지원하지 않거나 손상된 상태 DB입니다.")
            self.db.execute("PRAGMA foreign_keys=ON")
            self.db.execute("PRAGMA journal_mode=WAL")
            self.db.execute("PRAGMA synchronous=FULL")
            if not exists:
                self.db.executescript("""
                CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE media(media_id TEXT PRIMARY KEY, account TEXT NOT NULL, post_id TEXT NOT NULL,
                  ordinal INTEGER NOT NULL CHECK(ordinal>0), kind TEXT NOT NULL,
                  UNIQUE(account,post_id,ordinal));
                CREATE TABLE jobs(job_id TEXT PRIMARY KEY, media_id TEXT NOT NULL REFERENCES media(media_id),
                  source_rel TEXT NOT NULL, source_sha256 TEXT NOT NULL, source_type TEXT NOT NULL,
                  run_id TEXT NOT NULL, url_hash TEXT NOT NULL, status TEXT NOT NULL,
                  part_rel TEXT, final_rel TEXT, size INTEGER, sha256 TEXT, extension TEXT,
                  width INTEGER, height INTEGER, error_code TEXT, http_status INTEGER, content_type TEXT,
                  created_at REAL, updated_at REAL);
                CREATE TABLE requests(id INTEGER PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(job_id),
                  url_hash TEXT NOT NULL, hostname TEXT NOT NULL, hop INTEGER NOT NULL, consumed_at REAL NOT NULL,
                  http_status INTEGER, content_type TEXT, stage TEXT NOT NULL DEFAULT 'cdn_get');
                """)
                self.db.execute(f"PRAGMA application_id={APP_ID}")
                self.db.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
                library = uuid.uuid4().hex
                with self.db:
                    self.set_meta("library_id", library)
                    self.set_meta("root", str(self.root))
                    self.set_meta("policy", POLICY)
                    self.set_meta("last_clock", self.clock())
                durable_json(marker, {"schema_version": 1, "library_id": library})
            if self.meta("root") != str(self.root):
                raise StateError("root_changed", "기존 라이브러리의 이동·재연결 확인이 필요합니다.")
            if not supported_policy(self.meta("policy")):
                raise StateError("policy_mismatch", "저장된 요청 정책과 실행기 버전이 다릅니다.")
            safe_path(self.root, "media/.library.json", require_file=True)
            if json.loads(marker.read_text()).get("library_id") != self.meta("library_id"):
                raise StateError("library_mismatch", "미디어 폴더와 상태 DB가 일치하지 않습니다.")
            for rel in ("media/files", "media/.partial"):
                safe_path(self.root, rel).mkdir(exist_ok=True)
            if self.meta("policy") == LEGACY_POLICY:
                # User-authorized v2 removes only the daily cap. One transaction;
                # all requests, jobs, UUIDs, waits, stops and other meta survive.
                with self.db:
                    self.set_meta("policy", POLICY)
                    self.set_meta("policy_migration", {"from": LEGACY_POLICY, "to": POLICY,
                                                       "applied_at": self.clock()})
        except (sqlite3.Error, ValueError, OSError) as exc:
            if isinstance(exc, StateError):
                raise
            raise StateError("state_storage_error", "상태 저장소를 열 수 없습니다. 기존 자료를 보존했습니다.") from exc

    def meta(self, key, default=None):
        row = self.db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else default

    def set_meta(self, key, value):
        self.db.execute("INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                        (key, json.dumps(value, ensure_ascii=False)))

    def stop(self, code, retry_at=None, requires_review=False):
        with self.db:
            previous = self.meta("stop")
            value = {"code": code, "requires_review": requires_review}
            if previous != value:
                history = self.meta("stop_history", [])
                if previous and not history:
                    history.append({"stop": previous, "recordedAt": self.clock()})
                history.append({"stop": value, "recordedAt": self.clock()})
                self.set_meta("stop_history", history)
            self.set_meta("stop", value)
            if retry_at is not None:
                self.set_meta("next_allowed", max(float(retry_at), self.meta("next_allowed", 0)))

    def wait_until(self, deadline):
        with self.db:
            self.set_meta("next_allowed", max(float(deadline), self.meta("next_allowed", 0)))

    def guard(self):
        now = self.clock()
        # A clock problem must not downgrade a stronger persisted review gate
        # (for example a backup restored without complete request history).
        if now < self.meta("last_clock", now) - 1 and not self.meta("stop"):
            self.stop("clock_rollback", requires_review=True)
        with self.db:
            self.set_meta("last_clock", max(now, self.meta("last_clock", now)))
        if self.meta("stop"):
            raise StateError("stopped", "이전 오류·중단 상태가 있습니다. 자동 재개하지 않습니다.")
        if now < self.meta("next_allowed", 0):
            raise StateError("waiting", "저장된 대기 시간이 아직 지나지 않았습니다.")

    def reserve_request(self, job_id, url_hash, hostname, hop):
        self.guard()
        now = self.clock()
        with self.db:
            if type(hop) is not int or not 0 <= hop <= POLICY["max_redirects"]:
                raise StateError("redirect_limit", "허용된 리디렉션 횟수를 초과했습니다.")
            if self.db.execute("SELECT 1 FROM requests WHERE url_hash=? AND http_status IN (401,403) LIMIT 1", (url_hash,)).fetchone():
                raise StateError("url_recollection_required", "접근이 거절된 동일 주소는 다시 요청하지 않습니다. 새로 수집한 주소가 필요합니다.")
            self.db.execute("INSERT INTO requests(job_id,url_hash,hostname,hop,consumed_at) VALUES(?,?,?,?,?)",
                            (job_id, url_hash, hostname, hop, now))
