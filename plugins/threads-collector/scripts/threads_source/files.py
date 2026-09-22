"""Collection-only path, read stability, durability, and shared-lock helpers."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path, PureWindowsPath
import secrets
import stat
import uuid


class SourceError(ValueError):
    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(message)


def _signature(value):
    return value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns


def no_symlinks(path: Path):
    for item in [path, *path.parents]:
        if item.is_symlink():
            raise SourceError("symlink", "심볼릭 링크는 수집 원본 경로로 사용할 수 없습니다.")


def collection_root(root: Path) -> Path:
    root = Path(root)
    if not root.is_absolute():
        raise SourceError("invalid_root", "기존 수집 폴더의 절대 경로가 필요합니다.")
    no_symlinks(root)
    if not root.is_dir():
        raise SourceError("invalid_root", "기존 수집 폴더의 절대 경로가 필요합니다.")
    root = root.resolve()
    for parent in [root, *root.parents]:
        if (parent / ".codex-plugin/plugin.json").is_file():
            raise SourceError("plugin_storage", "플러그인 외부의 사용자 수집 폴더가 필요합니다.")
    return root


def safe_path(root: Path, relative: str, *, require_file: bool = False) -> Path:
    if not isinstance(relative, str) or not relative or any(c in relative for c in ("\\", "\x00", ":")):
        raise SourceError("unsafe_path", "수집 폴더 안의 일반 상대 경로가 필요합니다.")
    rel = Path(relative)
    if rel.is_absolute() or PureWindowsPath(relative).drive or any(piece in {"", ".", ".."} for piece in relative.split("/")):
        raise SourceError("unsafe_path", "수집 폴더 안의 일반 상대 경로가 필요합니다.")
    path = root / rel
    no_symlinks(path)
    if require_file:
        try:
            info = path.stat()
        except OSError as exc:
            raise SourceError("invalid_file", "수집 입력 파일을 읽을 수 없습니다.") from exc
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise SourceError("invalid_file", "단일 일반 파일이 필요합니다.")
    return path


def read_stable(path: Path, *, max_bytes: int) -> bytes:
    """Bounded no-follow read; reject replacement, hardlinks and non-regular files."""
    try:
        no_symlinks(path)
        before = path.stat()
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            raise SourceError("invalid_file", "단일 일반 파일이 필요합니다.")
        if before.st_size > max_bytes:
            raise SourceError("input_limit", "수집 입력 파일 크기 제한을 초과했습니다.")
        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
        with os.fdopen(os.open(path, flags), "rb") as stream:
            if _signature(os.fstat(stream.fileno())) != _signature(before):
                raise SourceError("source_changed", "읽기 시작 시 수집 입력이 변경되었습니다.")
            raw = stream.read(max_bytes + 1)
            after_read = os.fstat(stream.fileno())
        no_symlinks(path)
        after = path.stat()
        if len(raw) > max_bytes:
            raise SourceError("input_limit", "수집 입력 파일 크기 제한을 초과했습니다.")
        if _signature(before) != _signature(after_read) or _signature(before) != _signature(after) or len(raw) != before.st_size:
            raise SourceError("source_changed", "읽는 중 수집 입력이 변경되었습니다.")
        return raw
    except SourceError:
        raise
    except OSError as exc:
        raise SourceError("input_unavailable", "수집 입력 파일을 안전하게 읽을 수 없습니다.") from exc


def file_hash(path: Path, *, max_bytes: int = 64 * 1024 * 1024) -> str:
    return hashlib.sha256(read_stable(path, max_bytes=max_bytes)).hexdigest()


def sync_directory(path: Path):
    if os.name != "nt":
        fd = os.open(path, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def _pairs(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise SourceError("invalid_json", "JSON에 중복 필드가 있습니다.")
        value[key] = item
    return value


def parse_json(raw: bytes):
    try:
        return json.loads(raw, object_pairs_hook=_pairs,
                          parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    except (ValueError, UnicodeError, RecursionError) as exc:
        if isinstance(exc, SourceError):
            raise
        raise SourceError("invalid_json", "수집 JSON 입력을 해석할 수 없습니다.") from exc


class CollectionLock:
    """Own collector.lock or borrow an explicit collector token; never touch a DB."""
    def __init__(self, root: Path, *, token: str | None = None):
        self.root = collection_root(root)
        self.path = safe_path(self.root, "_work/collector.lock")
        self.borrowed_token = token
        self.token = uuid.uuid4().hex
        self.lock_data = None
        self.owns_lock = False
        self.inode = None

    def __enter__(self):
        if self.borrowed_token is not None:
            if not isinstance(self.borrowed_token, str) or not self.borrowed_token:
                raise SourceError("busy", "수집 잠금 토큰이 올바르지 않습니다.")
            self._check_borrowed()
            return self
        self.path.parent.mkdir(exist_ok=True)
        safe_path(self.root, "_work/collector.lock")
        payload = {"owner": "collection-source", "token": self.token, "pid": os.getpid()}
        try:
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
            with os.fdopen(os.open(self.path, flags, 0o600), "wb") as stream:
                self.owns_lock = True
                info = os.fstat(stream.fileno())
                self.inode = info.st_dev, info.st_ino
                stream.write(json.dumps(payload).encode("utf-8") + b"\n")
                stream.flush()
                os.fsync(stream.fileno())
            sync_directory(self.path.parent)
            return self
        except FileExistsError as exc:
            raise SourceError("busy", "다른 실행의 수집 잠금이 있습니다. 자동 제거하지 않습니다.") from exc
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def _check_borrowed(self):
        try:
            safe_path(self.root, "_work/collector.lock", require_file=True)
            info = self.path.stat()
            data = parse_json(read_stable(self.path, max_bytes=16 * 1024))
            if (not isinstance(data, dict) or data.get("owner") != "collector" or
                    not isinstance(data.get("token"), str) or not secrets.compare_digest(data["token"], self.borrowed_token) or
                    not isinstance(data.get("run_id"), str) or not data["run_id"]):
                raise SourceError("busy", "수집 잠금 토큰·실행 정보가 맞지 않습니다.")
            if self.inode is not None and self.inode != (info.st_dev, info.st_ino):
                raise SourceError("busy", "인계받은 수집 잠금이 교체되었습니다.")
            self.inode = info.st_dev, info.st_ino
            self.lock_data = data
        except (OSError, SourceError) as exc:
            raise SourceError("busy", "수집 잠금 인계를 검증할 수 없습니다.") from exc

    def assert_owned(self, run_id: str | None = None):
        if self.borrowed_token is not None:
            self._check_borrowed()
            if run_id is not None and self.lock_data["run_id"] != run_id:
                raise SourceError("run_conflict", "수집 잠금의 실행과 확정 자료가 다릅니다.")
        else:
            info = self.path.stat()
            data = parse_json(read_stable(self.path, max_bytes=16 * 1024))
            if (self.inode != (info.st_dev, info.st_ino) or not isinstance(data, dict) or
                    data.get("owner") != "collection-source" or data.get("token") != self.token):
                raise SourceError("busy", "소유한 수집 잠금이 변경되었습니다.")

    def __exit__(self, *args):
        if self.owns_lock:
            try:
                self.assert_owned()
                self.path.unlink()
                sync_directory(self.path.parent)
            except (OSError, ValueError):
                pass  # A changed/foreign lock is deliberately left in place.
            self.owns_lock = False
