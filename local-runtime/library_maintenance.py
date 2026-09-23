#!/usr/bin/env python3
"""Explicit local library backup, conservative restore, and relocation.

Normal restores replace publication metadata only: all current download, media,
edit and deletion records remain authoritative. Disaster restores require the
same media marker and place a permanent review stop on downloads because events
after the backup cannot be reconstructed. Media and Excel are never modified.
"""
from __future__ import annotations

from contextlib import closing, contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import sqlite3
import sys
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))
import collection_view as view
import edit_schema
from threads_runner import attempts
from threads_runner.deletion_state import database_deletions, excel_deletions, require_no_pending
from threads_runner.parent_monitor import MonitorError, ParentMonitor
from threads_runner.recovery import definitely_dead, release_abandoned
from threads_runner.state import APP_ID, SCHEMA_VERSION, StateError, file_hash, supported_policy
from threads_source.files import SourceError, collection_root, no_symlinks, read_stable, safe_path, sync_directory

INPUT_LIMIT = 32 * 1024
BACKUP_LIMIT = 2 * 1024 * 1024 * 1024
APP_NAME = "threads-media-manager"
BASE_COLUMNS = {
    "meta": ("key", "value"),
    "media": ("media_id", "account", "post_id", "ordinal", "kind"),
    "jobs": ("job_id", "media_id", "source_rel", "source_sha256", "source_type", "run_id", "url_hash", "status",
             "part_rel", "final_rel", "size", "sha256", "extension", "width", "height", "error_code", "http_status",
             "content_type", "created_at", "updated_at"),
    "requests": ("id", "job_id", "url_hash", "hostname", "hop", "consumed_at", "http_status", "content_type", "stage"),
}
OPTIONAL_COLUMNS = {
    "post_drafts": view.POST_DRAFT_COLUMNS,
    "post_comments": ("account", "post_id", "caption", "link", "updated_at"),
    "post_deletions": ("account", "post_id", "deleted_at"),
    "edit_deletions": ("edit_id", "deleted_at"),
    "deletion_operations": ("id", "journal_sha256", "status"),
    "job_attempts": ("previous_job_id", "replacement_job_id", "reason", "created_at"),
    "backup_manifest": ("id", "app_name", "app_version", "schema_version", "library_id", "created_at", "schema_sha256"),
}
DRAFT_SQL = """CREATE TABLE IF NOT EXISTS post_drafts(
    account TEXT NOT NULL,post_id TEXT NOT NULL,caption TEXT NOT NULL,media_ids_json TEXT NOT NULL,
    created_at TEXT NOT NULL,updated_at TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),PRIMARY KEY(account,post_id))"""
COMMENT_SQL = """CREATE TABLE IF NOT EXISTS post_comments(
    account TEXT NOT NULL,post_id TEXT NOT NULL,caption TEXT NOT NULL,link TEXT NOT NULL,
    updated_at TEXT NOT NULL,PRIMARY KEY(account,post_id))"""


class MaintenanceError(ValueError):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


def check_cancel(check):
    if check():
        raise MaintenanceError("cancelled", "자료 관리 작업을 완료하지 않았습니다. 다시 확인하세요.")


def signature(path):
    value = path.stat()
    return value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns


def external_path(value, *, existing=False):
    if not isinstance(value, str) or not value or "\0" in value or len(value) > 32768:
        raise MaintenanceError("invalid_path", "백업 파일의 절대 경로를 확인하세요.")
    path = Path(value)
    if not path.is_absolute():
        raise MaintenanceError("invalid_path", "백업 파일의 절대 경로가 필요합니다.")
    no_symlinks(path)
    if not path.parent.is_dir():
        raise MaintenanceError("invalid_path", "백업 파일의 상위 폴더가 필요합니다.")
    if (existing or path.exists()) and (not path.is_file() or path.stat().st_nlink != 1):
        raise MaintenanceError("invalid_file", "단일 일반 백업 파일이 필요합니다.")
    return path.resolve()


def json_meta(db):
    return {key: json.loads(value) for key, value in db.execute("SELECT key,value FROM meta")}


def schema_digest(db):
    rows = db.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name!='backup_manifest' ORDER BY type,name").fetchall()
    return hashlib.sha256(json.dumps([tuple(row) for row in rows], ensure_ascii=False).encode()).hexdigest()


def validate_db(db, *, backup=False):
    db.execute("PRAGMA trusted_schema=OFF")
    if (db.execute("PRAGMA application_id").fetchone()[0] != APP_ID or
            db.execute("PRAGMA user_version").fetchone()[0] != SCHEMA_VERSION or
            [row[0] for row in db.execute("PRAGMA integrity_check")] != ["ok"] or
            db.execute("PRAGMA foreign_key_check").fetchone()):
        raise MaintenanceError("invalid_database", "지원하지 않거나 손상된 DB입니다.")
    tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    allowed = set(BASE_COLUMNS) | set(OPTIONAL_COLUMNS) | {"media_edits"}
    if not set(BASE_COLUMNS) <= tables or tables - allowed:
        raise MaintenanceError("invalid_schema", "지원하지 않는 DB 테이블 형식입니다.")
    if db.execute("SELECT 1 FROM sqlite_master WHERE type IN ('trigger','view')").fetchone():
        raise MaintenanceError("invalid_schema", "추가된 DB 뷰·트리거를 확인해야 합니다.")
    for table in tables:
        columns = tuple(row[1] for row in db.execute(f'PRAGMA table_info("{table}")'))
        expected = BASE_COLUMNS.get(table, OPTIONAL_COLUMNS.get(table))
        if table == "media_edits":
            valid = columns in (edit_schema.BASE_COLUMNS, edit_schema.BASE_COLUMNS + edit_schema.TRIM_COLUMNS)
        else:
            valid = columns == expected
        if not valid:
            raise MaintenanceError("invalid_schema", "DB 열 형식이 현재 앱과 맞지 않습니다.")
    meta = json_meta(db)
    if (not isinstance(meta.get("library_id"), str) or not re.fullmatch(r"[a-f0-9]{32}", meta["library_id"]) or
            not isinstance(meta.get("root"), str) or not Path(meta["root"]).is_absolute() or
            not supported_policy(meta.get("policy"))):
        raise MaintenanceError("invalid_database", "DB의 라이브러리 식별 정보·정책을 확인해야 합니다.")
    view.read_drafts(None, db=db)
    read_comments(db)
    database_deletions(None, db)
    previous_factory = db.row_factory
    try:
        db.row_factory = sqlite3.Row
        attempts.retired_ids(db)
    finally:
        db.row_factory = previous_factory
    if backup:
        if "backup_manifest" not in tables:
            raise MaintenanceError("invalid_backup", "이 앱에서 생성한 백업 파일이 아닙니다.")
        rows = db.execute("SELECT * FROM backup_manifest").fetchall()
        if (len(rows) != 1 or rows[0][0] != 1 or rows[0][1] != APP_NAME or
                not isinstance(rows[0][2], str) or not rows[0][2] or rows[0][3] != SCHEMA_VERSION or
                rows[0][4] != meta["library_id"] or rows[0][6] != schema_digest(db)):
            raise MaintenanceError("invalid_backup", "백업의 앱·버전·라이브러리 검증에 실패했습니다.")
        datetime.fromisoformat(rows[0][5])
    return meta


def read_comments(db):
    if not db.execute("SELECT 1 FROM sqlite_master WHERE name='post_comments'").fetchone():
        return []
    rows = db.execute("SELECT account,post_id,caption,link,updated_at FROM post_comments").fetchall()
    for account, post_id, caption, link, updated in rows:
        if not all(isinstance(value, str) for value in (account, post_id, caption, link, updated)) or not account or not post_id:
            raise MaintenanceError("invalid_backup", "백업의 댓글 정보 형식이 잘못되었습니다.")
        view.draft_caption(caption)
        if not (caption or link) or len(link.encode("utf-16-le")) // 2 > 2048:
            raise MaintenanceError("invalid_backup", "백업의 댓글 정보가 올바르지 않습니다.")
        view.validate_comment_link(link)
        date = datetime.fromisoformat(updated)
        if date.tzinfo is None:
            raise MaintenanceError("invalid_backup", "백업의 댓글 시각을 확인하세요.")
    return rows


def marker_id(root):
    marker = json.loads(read_stable(safe_path(root, "media/.library.json", require_file=True), max_bytes=4096))
    if (not isinstance(marker, dict) or marker.get("schema_version") != 1 or
            not isinstance(marker.get("library_id"), str) or not re.fullmatch(r"[a-f0-9]{32}", marker["library_id"])):
        raise MaintenanceError("library_mismatch", "미디어 폴더의 식별 정보를 확인하세요.")
    return marker["library_id"]


@contextmanager
def maintenance_lock(root, *, recover_download=False):
    path = safe_path(root, "_work/collector.lock")
    path.parent.mkdir(exist_ok=True)
    # Only this worker's definitely abandoned lock may be released. A collector,
    # downloader, delete worker, or uncertain owner always requires its own flow.
    if path.exists():
        raw = read_stable(path, max_bytes=4096)
        existing = json.loads(raw)
        if (isinstance(existing, dict) and existing.get("owner") in
                ({"library-maintenance", "download-runner"} if recover_download else {"library-maintenance"}) and
                re.fullmatch(r"[a-f0-9]{32}", str(existing.get("token", ""))) and definitely_dead(existing.get("pid"))):
            # Rename rather than unlink: exclusively claim this exact abandoned
            # inode, then verify it. Other owners never get deleted.
            if existing["owner"] == "download-runner" and (root / "state/state.db").is_file():
                release_abandoned(root)
            else:
                # A missing DB still permits an explicit disaster restore. The
                # same dead-owner check applies, without creating a fresh DB.
                claim = path.with_name("maintenance-claim-" + uuid.uuid4().hex)
                os.rename(path, claim)
                if read_stable(claim, max_bytes=4096) != raw:
                    if not path.exists(): os.rename(claim, path)
                    raise MaintenanceError("busy", "잠금 소유자가 변경되었습니다.")
                claim.unlink()
        else:
            raise MaintenanceError("busy", "수집·다운로드·다른 자료 작업이 끝난 뒤 진행하세요.")
    token = uuid.uuid4().hex
    try:
        with path.open("x", encoding="utf-8") as stream:
            json.dump({"owner": "library-maintenance", "pid": os.getpid(), "token": token}, stream)
            stream.flush()
            os.fsync(stream.fileno())
    except FileExistsError as exc:
        raise MaintenanceError("busy", "다른 자료 작업이 진행 중입니다.") from exc
    sync_directory(path.parent)
    def assert_owned():
        if json.loads(read_stable(path, max_bytes=4096)).get("token") != token:
            raise MaintenanceError("busy", "자료 관리 잠금이 변경되었습니다.")
    try:
        yield assert_owned
    finally:
        try:
            assert_owned()
            path.unlink()
            sync_directory(path.parent)
        except (OSError, ValueError):
            pass


def validate_ai_drafts(db, root, available, deleted, *, drafts=None, check=lambda: False, strict=False):
    """Resolve AI references for restore without enabling generation or changing files."""
    drafts = view.read_drafts(root, db=db) if drafts is None else drafts
    for key, draft in drafts.items():
        if key in deleted or all(available.get(identifier) == key for identifier in draft["mediaIds"]):
            continue
        check_cancel(check)
        original_ids = [row[0] for row in db.execute(
            "SELECT media_id FROM media WHERE account=? AND post_id=? AND kind='image' ORDER BY ordinal", key)]
        post_key = json.dumps(key, ensure_ascii=False, separators=(",", ":"))
        try:
            _items, files, _warnings = view.ai_media.read_post(root, post_key, original_ids)
            for item in files:
                if item["id"] in available and available[item["id"]] != key:
                    raise ValueError("Conflicting AI identifier")
                available[item["id"]] = key
        except (SourceError, OSError, ValueError, TypeError) as exc:
            raise MaintenanceError("restore_media_unavailable", "등록 게시글의 AI 생성 이미지를 확인할 수 없습니다.") from exc
        if strict and any(available.get(identifier) != key for identifier in draft["mediaIds"]):
            raise MaintenanceError("restore_media_unavailable", "등록 게시글의 미디어가 현재 라이브러리에 없습니다.")


def validate_files(db, root, *, check=lambda: False):
    """Hash active completed files and edits, not tombstoned deleted files."""
    deleted, deleted_edits = database_deletions(root, db)
    deleted |= excel_deletions(root)
    records = db.execute("""SELECT m.media_id,m.account,m.post_id,j.final_rel,j.size,j.sha256
        FROM jobs j JOIN media m USING(media_id) WHERE j.status='complete'""").fetchall()
    if db.execute("SELECT 1 FROM sqlite_master WHERE name='media_edits'").fetchone():
        records += db.execute("SELECT edit_id,account,post_id,final_rel,size,sha256 FROM media_edits").fetchall()
    available = {}
    for media_id, account, post_id, relative, size, digest in records:
        check_cancel(check)
        if (account, post_id) in deleted or media_id in deleted_edits:
            continue
        if (not isinstance(relative, str) or not relative.startswith("media/files/") or
                type(size) is not int or size <= 0 or not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest)):
            raise MaintenanceError("invalid_media", "완료 미디어의 파일 정보가 잘못되었습니다.")
        path = safe_path(root, relative, require_file=True)
        before = signature(path)
        if path.stat().st_size != size or file_hash(path) != digest or signature(path) != before:
            raise MaintenanceError("media_mismatch", "완료 미디어가 누락되거나 변경되었습니다. 기존 파일은 보존했습니다.")
        available[media_id] = (account, post_id)
    validate_ai_drafts(db, root, available, deleted, check=check)
    return available, deleted


def open_db(path, *, readonly=False):
    db = sqlite3.connect(path.as_uri() + ("?mode=ro" if readonly else "?mode=rw"), uri=True, timeout=0)
    db.execute("PRAGMA trusted_schema=OFF")
    db.execute("PRAGMA foreign_keys=ON")
    if not readonly: db.execute("PRAGMA synchronous=FULL")
    return db


def online_backup(db, destination, library, app_version, check):
    temporary = destination.with_name(destination.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with temporary.open("xb"):
            pass
        with closing(sqlite3.connect(temporary)) as copy:
            db.backup(copy, pages=128, progress=lambda *_: check_cancel(check))
            copy.execute("PRAGMA journal_mode=DELETE")
            with copy:
                copy.execute("""CREATE TABLE IF NOT EXISTS backup_manifest(
                    id INTEGER PRIMARY KEY CHECK(id=1), app_name TEXT NOT NULL,app_version TEXT NOT NULL,
                    schema_version INTEGER NOT NULL,library_id TEXT NOT NULL,created_at TEXT NOT NULL,schema_sha256 TEXT NOT NULL)""")
                copy.execute("INSERT OR REPLACE INTO backup_manifest VALUES(1,?,?,?,?,?,?)",
                    (APP_NAME, app_version, SCHEMA_VERSION, library, datetime.now(timezone.utc).isoformat(), schema_digest(copy)))
            validate_db(copy, backup=True)
        check_cancel(check)
        with temporary.open("rb") as stream: os.fsync(stream.fileno())
        os.replace(temporary, destination)
        sync_directory(destination.parent)
    finally:
        for suffix in ("", "-journal", "-wal", "-shm"):
            pending = Path(str(temporary) + suffix)
            if pending.exists(): pending.unlink()


def safe_db_path(root):
    path = safe_path(root, "state/state.db")
    for suffix in ("", "-wal", "-shm", "-journal"):
        item = safe_path(root, "state/state.db" + suffix)
        if item.exists(): safe_path(root, "state/state.db" + suffix, require_file=True)
    return path


def reconnect(root, db_path, library, check, assert_owned):
    """Connect without initializing absent state; rebind only validated state."""
    result = {"ok": True, "operation": "reconnect", "library_id": library}
    if not db_path.exists():
        return result
    # Inspect before any writable connection. Missing/corrupt state must remain
    # selectable for explicit restore, while foreign/unsupported state is never
    # rebound or treated as a fresh library.
    try:
        with closing(open_db(db_path, readonly=True)) as db:
            if db.execute("PRAGMA application_id").fetchone()[0] != APP_ID:
                raise MaintenanceError("foreign_database", "다른 앱의 DB는 재연결로 변경하지 않습니다.")
            if db.execute("PRAGMA user_version").fetchone()[0] != SCHEMA_VERSION:
                raise MaintenanceError("unsupported_database", "현재 DB 버전을 지원하는 앱으로 연결하세요.")
            current_id = db.execute("SELECT value FROM meta WHERE key='library_id'").fetchone()
            if current_id and json.loads(current_id[0]) != library:
                raise MaintenanceError("library_mismatch", "DB와 미디어 폴더가 서로 다른 라이브러리입니다.")
            validate_db(db)
    except MaintenanceError as exc:
        if exc.code != "invalid_database":
            raise
        return result
    except sqlite3.DatabaseError as exc:
        if getattr(exc, "sqlite_errorcode", None) not in {sqlite3.SQLITE_CORRUPT, sqlite3.SQLITE_NOTADB}:
            raise
        return result
    except (json.JSONDecodeError, TypeError):
        return result
    with closing(open_db(db_path)) as db:
        meta = validate_db(db)
        if meta["library_id"] != library:
            raise MaintenanceError("library_mismatch", "DB와 미디어 폴더가 서로 다른 라이브러리입니다.")
        # Updating only root preserves running/staged state, parts, waits and
        # stop; the download recovery worker handles interrupted jobs next.
        validate_files(db, root, check=check)
        with db:
            db.execute("BEGIN IMMEDIATE")
            assert_owned()
            check_cancel(check)
            if marker_id(root) != library:
                raise MaintenanceError("library_mismatch", "재연결 도중 라이브러리 식별 정보가 변경되었습니다.")
            db.execute("UPDATE meta SET value=? WHERE key='root'", (json.dumps(str(root)),))
    return result


def metadata_restore(db, backup, root, available, deleted, check):
    drafts = view.read_drafts(root, db=backup)
    current = view.read_drafts(root, db=db)
    accepted = {key: value for key, value in drafts.items() if key not in deleted}
    validate_ai_drafts(db, root, available, deleted, drafts=accepted, check=check, strict=True)
    for key, draft in accepted.items():
        if any(available.get(media_id) != key for media_id in draft["mediaIds"]):
            raise MaintenanceError("restore_media_unavailable", "백업 등록 게시글의 미디어가 현재 라이브러리에 없습니다.")
        if max(draft["revision"], current.get(key, {}).get("revision", 0)) >= view.MAX_DRAFT_REVISION:
            raise MaintenanceError("draft_revision_limit", "등록 정보의 수정 버전 상한을 확인하세요.")
    comments = [tuple(row) for row in read_comments(backup) if tuple(row[:2]) not in deleted]
    with db:
        db.execute("BEGIN IMMEDIATE")
        db.execute(DRAFT_SQL)
        db.execute(COMMENT_SQL)
        db.execute("DELETE FROM post_drafts")
        db.execute("DELETE FROM post_comments")
        for (account, post_id), draft in accepted.items():
            db.execute("INSERT INTO post_drafts VALUES(?,?,?,?,?,?,?)", (account, post_id, draft["caption"],
                json.dumps(draft["mediaIds"]), draft["createdAt"], draft["updatedAt"],
                max(draft["revision"], current.get((account, post_id), {}).get("revision", 0)) + 1))
        db.executemany("INSERT INTO post_comments VALUES(?,?,?,?,?)", comments)
        check_cancel(check)
    return len(accepted), len(comments)


def disaster_restore(backup, root, db_path, library, app_version, check, assert_owned):
    # The replacement is a self-contained, validated SQLite file. An interrupted
    # replacement cannot expose an empty fresh database: media marker already
    # exists and the worker holds the shared lock until atomic rename finishes.
    temporary = root / "state" / ("restore-" + uuid.uuid4().hex + ".sqlite")
    automatic = None
    backups = safe_path(root, "state/backups")
    backups.mkdir(exist_ok=True)
    try:
        online_backup(backup, temporary, library, app_version, check)
        with closing(open_db(temporary)) as copy:
            with copy:
                copy.execute("INSERT OR REPLACE INTO meta VALUES('root',?)", (json.dumps(str(root)),))
                prior = json_meta(copy).get("stop")
                copy.execute("INSERT OR REPLACE INTO meta VALUES('stop',?)", (json.dumps({"code": "database_restored", "requires_review": True,
                    "previous_stop": prior}),))
                copy.execute("INSERT OR REPLACE INTO meta VALUES('restore_history_review',?)", (json.dumps({
                    "backup_created_at": copy.execute("SELECT created_at FROM backup_manifest").fetchone()[0],
                    "restored_at": datetime.now(timezone.utc).isoformat(), "history_after_backup_unknown": True}),))
                # Roots and recovery stop changed, not the SQL schema.
            validate_db(copy, backup=True)
            validate_files(copy, root, check=check)
        if db_path.exists() or any(Path(str(db_path) + suffix).exists() for suffix in ("-wal", "-shm", "-journal")):
            automatic = backups / ("before-restore-" + uuid.uuid4().hex + ".sqlite")
            for suffix in ("", "-wal", "-shm", "-journal"):
                old = Path(str(db_path) + suffix)
                if old.exists():
                    target = Path(str(automatic) + suffix)
                    with old.open("rb") as source, target.open("xb") as output:
                        shutil.copyfileobj(source, output)
                        output.flush()
                        os.fsync(output.fileno())
            sync_directory(backups)
        check_cancel(check)
        assert_owned()
        if marker_id(root) != library:
            raise MaintenanceError("library_mismatch", "복원 도중 미디어 폴더의 식별 정보가 변경되었습니다.")
        # No cancellation boundary between removing incompatible old sidecars
        # and replacing their already-invalid/missing main DB. A process kill
        # leaves the original raw safety copy and a complete replacement file.
        for suffix in ("-wal", "-shm", "-journal"):
            sidecar = Path(str(db_path) + suffix)
            if sidecar.exists(): sidecar.unlink()
        with temporary.open("rb") as stream: os.fsync(stream.fileno())
        os.replace(temporary, db_path)
        sync_directory(db_path.parent)
        return automatic
    finally:
        if temporary.exists(): temporary.unlink()


def execute(data, *, check=lambda: False):
    if (not isinstance(data, dict) or data.get("command") not in {"backup", "restore", "reconnect"} or
            set(data) - {"command", "root", "path", "appVersion"} or not isinstance(data.get("root"), str)):
        raise MaintenanceError("invalid_request", "자료 관리 요청 형식을 확인하세요.")
    command = data["command"]
    app_version = data.get("appVersion", "development")
    if not isinstance(app_version, str) or not 1 <= len(app_version) <= 128:
        raise MaintenanceError("invalid_request", "앱 버전 형식을 확인하세요.")
    root = collection_root(Path(data["root"]))
    require_no_pending(root)
    marker = safe_path(root, "media/.library.json")
    library = None if command == "reconnect" and not marker.exists() else marker_id(root)
    check_cancel(check)
    with maintenance_lock(root, recover_download=command in {"restore", "reconnect"}) as assert_owned:
        require_no_pending(root)
        current_library = marker_id(root) if marker.exists() else None
        if current_library != library:
            raise MaintenanceError("library_mismatch", "작업 시작 도중 라이브러리 식별 정보가 변경되었습니다.")
        if list(root.glob("~$*.xlsx")) or list((root / "results").rglob("~$*.xlsx")):
            raise MaintenanceError("excel_busy", "열려 있는 Excel 파일을 닫고 진행하세요.")
        db_path = safe_db_path(root)
        if command == "reconnect":
            if db_path.exists() and library is None:
                raise MaintenanceError("library_mismatch", "기존 DB와 연결할 미디어 폴더의 식별 정보가 필요합니다.")
            return reconnect(root, db_path, library, check, assert_owned)
        path = external_path(data.get("path"), existing=command == "restore")
        if (path == db_path or root / "media" in path.parents or
                (root / "state" in path.parents and (command != "restore" or root / "state/backups" not in path.parents))):
            raise MaintenanceError("unsafe_path", "현재 DB·미디어 폴더 밖의 백업 파일을 선택하세요.")
        if any(Path(str(path) + suffix).exists() for suffix in ("-wal", "-shm", "-journal")):
            raise MaintenanceError("backup_busy", "사용 중인 SQLite 파일 대신 앱이 만든 닫힌 백업 파일을 선택하세요.")
        if command == "backup":
            with closing(open_db(db_path, readonly=True)) as db:
                meta = validate_db(db)
                if meta["library_id"] != library or meta["root"] != str(root):
                    raise MaintenanceError("library_mismatch", "먼저 기존 라이브러리 폴더를 재연결하세요.")
                assert_owned()
                online_backup(db, path, library, app_version, check)
            return {"ok": True, "operation": command, "library_id": library, "file_path": data["path"]}
        # Snapshot caller-selected input into our own directory before validation;
        # immutable inspection cannot follow input WAL or a concurrently replaced
        # file. Backup destinations are closed checkpointed SQLite files.
        if path.stat().st_size > BACKUP_LIMIT:
            raise MaintenanceError("backup_limit", "백업 파일이 지원 크기를 초과했습니다.")
        safe_path(root, "state").mkdir(exist_ok=True)
        snapshot = safe_path(root, "state/restore-input-" + uuid.uuid4().hex + ".sqlite")
        try:
            before = signature(path)
            with path.open("rb") as source, snapshot.open("xb") as output:
                shutil.copyfileobj(source, output)
            if signature(path) != before:
                raise MaintenanceError("source_changed", "선택한 백업 파일이 읽는 중 변경되었습니다.")
            with closing(open_db(snapshot, readonly=True)) as backup:
                saved = validate_db(backup, backup=True)
                if saved["library_id"] != library:
                    raise MaintenanceError("library_mismatch", "현재 미디어 폴더와 같은 라이브러리의 백업이 필요합니다.")
                db = None
                normal = False
                try:
                    if db_path.exists():
                        db = open_db(db_path)
                        app_id = db.execute("PRAGMA application_id").fetchone()[0]
                        if app_id != APP_ID:
                            raise MaintenanceError("foreign_database", "다른 앱의 DB는 복원으로 덮어쓰지 않습니다.")
                        if db.execute("PRAGMA user_version").fetchone()[0] != SCHEMA_VERSION:
                            raise MaintenanceError("unsupported_database", "현재 DB 버전을 지원하는 앱으로 복원하세요.")
                        current_id = db.execute("SELECT value FROM meta WHERE key='library_id'").fetchone()
                        if current_id and json.loads(current_id[0]) != library:
                            raise MaintenanceError("library_mismatch", "현재 DB가 다른 라이브러리입니다. 덮어쓰지 않았습니다.")
                        current = validate_db(db)
                        normal = True
                except MaintenanceError as exc:
                    if db is not None: db.close()
                    db = None
                    if exc.code not in {"invalid_database"}:
                        raise
                except (sqlite3.DatabaseError, ValueError, TypeError):
                    if db is not None: db.close()
                    db = None
                if normal:
                    try:
                        if current["library_id"] != library:
                            raise MaintenanceError("library_mismatch", "현재 DB가 다른 라이브러리입니다. 덮어쓰지 않았습니다.")
                        if current["root"] != str(root):
                            raise MaintenanceError("root_changed", "폴더 재연결 후 백업을 복원하세요.")
                        if db.execute("SELECT 1 FROM jobs WHERE status IN ('running','staged')").fetchone():
                            raise MaintenanceError("recovery_required", "다운로드 파일 복구를 먼저 진행하세요.")
                        available, deleted = validate_files(db, root, check=check)
                        backups = safe_path(root, "state/backups")
                        backups.mkdir(exist_ok=True)
                        automatic = backups / ("before-restore-" + uuid.uuid4().hex + ".sqlite")
                        online_backup(db, automatic, library, app_version, check)
                        assert_owned()
                        if marker_id(root) != library:
                            raise MaintenanceError("library_mismatch", "복원 도중 라이브러리 식별 정보가 변경되었습니다.")
                        counts = metadata_restore(db, backup, root, available, deleted, check)
                    finally:
                        db.close()
                    return {"ok": True, "operation": command, "library_id": library, "restore_mode": "metadata",
                        "history_review_required": False, "automatic_backup_path": str(Path(data["root"]) / automatic.relative_to(root)),
                        "restored_drafts": counts[0], "restored_comments": counts[1]}
                validate_files(backup, root, check=check)
                assert_owned()
                automatic = disaster_restore(backup, root, db_path, library, app_version, check, assert_owned)
                result = {"ok": True, "operation": command, "library_id": library,
                          "restore_mode": "full", "history_review_required": True}
                if automatic:
                    result["automatic_backup_path"] = str(Path(data["root"]) / automatic.relative_to(root))
                return result
        finally:
            if snapshot.exists(): snapshot.unlink()


def main():
    stopped = False
    monitor = None
    def stop(*_):
        nonlocal stopped
        stopped = True
    for sig in (signal.SIGTERM, signal.SIGINT): signal.signal(sig, stop)
    try:
        monitor = ParentMonitor()
        raw = sys.stdin.buffer.read(INPUT_LIMIT + 1)
        if not raw or len(raw) > INPUT_LIMIT:
            raise MaintenanceError("invalid_request", "자료 관리 요청의 크기를 확인하세요.")
        result = execute(json.loads(raw), check=lambda: stopped or monitor.cancelled())
    except (MaintenanceError, StateError, SourceError, MonitorError) as exc:
        result = {"ok": False, "code": exc.code, "message": str(exc)}
    except Exception:
        result = {"ok": False, "code": "maintenance_failed", "message": "자료 관리 작업을 완료하지 못했습니다. 기존 자료와 백업을 보존했습니다."}
    finally:
        if monitor is not None: monitor.close()
    print(json.dumps(result, ensure_ascii=False, allow_nan=False), flush=True)
    return 0 if result["ok"] else 1


if __name__ == "__main__": sys.exit(main())
