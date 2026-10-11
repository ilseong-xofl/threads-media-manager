#!/usr/bin/env python3
"""Import explicitly selected files and a caption as one local publication draft."""
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))
import collection_view as view
import delete_media
import local_post_store as store
import post_draft
from threads_runner.deletion_state import database_deletions, require_no_pending
from threads_runner.parent_monitor import MonitorError, ParentMonitor
from threads_runner.recovery import definitely_dead
from threads_runner.state import State, StateError
from threads_runner.transport import TransferError, _image_metadata
from threads_source.files import CollectionLock, SourceError, collection_root, no_symlinks, parse_json, read_stable, safe_path, stat_signature, sync_directory

INPUT_LIMIT = 4*1024*1024


class LocalPostError(ValueError):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


class LocalPostLock(CollectionLock):
    def __enter__(self):
        self.path.parent.mkdir(exist_ok=True)
        if self.path.exists():
            raw = read_stable(self.path, max_bytes=4096)
            value = parse_json(raw)
            if (not isinstance(value, dict) or value.get("owner") != "local-post" or
                    not view.UUID.fullmatch(str(value.get("token", ""))) or not definitely_dead(value.get("pid"))):
                raise LocalPostError("busy", "다른 자료 작업이 진행 중입니다. 종료 후 다시 등록하세요.")
            claim = self.path.with_name("local-post-claim-"+uuid.uuid4().hex)
            os.rename(self.path, claim)
            if read_stable(claim, max_bytes=4096) != raw:
                if not self.path.exists():
                    os.rename(claim, self.path)
                raise LocalPostError("busy", "자료 작업의 잠금이 변경되었습니다.")
            claim.unlink()
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        try:
            with os.fdopen(os.open(self.path, flags, 0o600), "wb") as output:
                self.owns_lock = True
                info = os.fstat(output.fileno())
                self.inode = info.st_dev, info.st_ino
                output.write(delete_media.encoded({"owner": "local-post", "pid": os.getpid(), "token": self.token}))
                output.flush()
                os.fsync(output.fileno())
            sync_directory(self.path.parent)
            return self
        except FileExistsError as exc:
            raise LocalPostError("busy", "다른 자료 작업이 진행 중입니다.") from exc
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def assert_owned(self, run_id=None):
        value = parse_json(read_stable(self.path, max_bytes=4096))
        info = self.path.stat()
        if self.inode != (info.st_dev, info.st_ino) or value.get("owner") != "local-post" or value.get("token") != self.token:
            raise LocalPostError("busy", "개인 글 등록 잠금이 변경되었습니다.")


def recover_imports(root, db, check):
    """Keep committed imports; roll back only journal-owned unfinished copies."""
    library = json.loads(db.execute("SELECT value FROM meta WHERE key='library_id'").fetchone()[0])
    posts, media = store.read(db, library)
    keys = {(item["account"], item["post_id"]) for item in posts}
    recovered = 0
    for folder in sorted(safe_path(root, "_work").glob("local-post-????????????????????????????????")):
        if not re.fullmatch(r"local-post-[a-f0-9]{32}", folder.name):
            continue
        safe_path(root, folder.relative_to(root).as_posix())
        if not (folder / "journal.json").exists():
            continue  # Unknown/unpublished temporary material is never deletion authority.
        journal = safe_path(root, f"_work/{folder.name}/journal.json", require_file=True)
        value = parse_json(read_stable(journal, max_bytes=INPUT_LIMIT))
        if (not isinstance(value, dict) or value.get("version") != 1 or value.get("root") != str(root) or
                value.get("libraryId") != library or value.get("postId") != folder.name[11:] or
                not isinstance(value.get("files"), list) or not 1 <= len(value["files"]) <= 100):
            raise LocalPostError("local_post_recovery_required", "미완료 개인 글의 복구 기록을 확인하세요.")
        committed = (store.ACCOUNT, value["postId"]) in keys
        owned = []
        seen = set()
        for item in value["files"]:
            identifier = item.get("mediaId") if isinstance(item, dict) else None
            if (not isinstance(identifier, str) or not view.UUID.fullmatch(identifier) or identifier in seen or
                    not re.fullmatch(identifier+r"\.[a-z0-9]{1,8}", str(item.get("stage", ""))) or
                    (item.get("identity") is not None and (not isinstance(item["identity"], list) or len(item["identity"]) != 2 or
                        any(type(part) is not int for part in item["identity"]))) or
                    type(item.get("size")) is not int or not 0 < item["size"] <= 1024**3 or
                    not isinstance(item.get("sha256"), str) or not re.fullmatch(r"[a-f0-9]{64}", item["sha256"])):
                raise LocalPostError("local_post_recovery_required", "개인 글 복구 파일의 소유 정보를 확인하세요.")
            seen.add(identifier)
            paths = [(safe_path(root, f"_work/{folder.name}/{item['stage']}"), False)]
            relative = item.get("final")
            if relative is not None:
                match = view.FILE.fullmatch(relative)
                if not match or match[1] != identifier or not relative.startswith(f"media/files/{library}/"):
                    raise LocalPostError("local_post_recovery_required", "개인 글 복구 경로를 확인하세요.")
                paths.append((safe_path(root, relative), True))
            if committed:
                record = next((row for row in media if row["media_id"] == identifier and row["post_id"] == value["postId"]), None)
                if not record or record["final_rel"] != relative:
                    raise LocalPostError("local_post_recovery_required", "완료된 개인 글과 복구 기록이 다릅니다.")
                view.local_file(root, record)
            for path, final in paths:
                cancelled(check)
                if not path.exists() or (committed and final):
                    continue
                info = path.lstat()
                identity = [info.st_dev, info.st_ino]
                if (not stat.S_ISREG(info.st_mode) or info.st_nlink not in {1, 2} or
                        (item.get("identity") != identity and not (not final and item.get("identity") is None and info.st_size == 0))):
                    raise LocalPostError("local_post_recovery_required", "복구 대상 파일이 변경되어 보존했습니다.")
                if final:
                    # A crash between link and unlink legitimately leaves two
                    # names for this inode, so validate bytes without requiring
                    # the normal single-link media invariant until cleanup.
                    digest = hashlib.sha256()
                    with path.open("rb") as stream:
                        opened = os.fstat(stream.fileno())
                        for block in iter(lambda: stream.read(1024*1024), b""):
                            digest.update(block)
                    after = path.lstat()
                    if (stat_signature(opened) != stat_signature(info) or stat_signature(after) != stat_signature(info) or
                            info.st_size != item["size"] or digest.hexdigest() != item["sha256"]):
                        raise LocalPostError("local_post_recovery_required", "복구 대상 파일이 변경되어 보존했습니다.")
                owned.append(path)
        for path in owned:
            path.unlink()
        journal.unlink()
        # Unknown extra files are preserved; only our now-empty folder is removed.
        try:
            folder.rmdir()
        except OSError:
            pass
        recovered += 1
    return recovered


def recover(root, *, check=lambda: False):
    root = collection_root(Path(root))
    require_no_pending(root)
    with LocalPostLock(root) as lock:
        if not safe_path(root, "state/state.db").exists():
            return {"ok": True, "recovered": 0}
        with closing(delete_media.open_db(root, "rw")) as db:
            result = recover_imports(root, db, check)
            lock.assert_owned()
            return {"ok": True, "recovered": result}


def cancelled(check):
    if check():
        raise LocalPostError("cancelled", "개인 글 등록을 취소했습니다.")


def validate(data):
    if (not isinstance(data, dict) or set(data) != {"root", "postId", "caption", "files"} or
            not isinstance(data["root"], str) or not isinstance(data["postId"], str) or
            not view.UUID.fullmatch(data["postId"]) or not isinstance(data["files"], list) or not 1 <= len(data["files"]) <= 100):
        raise LocalPostError("invalid_request", "개인 글 등록 요청을 확인하세요.")
    try:
        view.draft_caption(data["caption"])
    except (ValueError, TypeError) as exc:
        raise LocalPostError("invalid_caption", "캡션은 10,000자 이내로 입력하세요.") from exc
    seen = set()
    for item in data["files"]:
        if (not isinstance(item, dict) or set(item) != {"path", "mediaId", "kind", "size", "sha256"} or
                not isinstance(item["path"], str) or not item["path"] or "\0" in item["path"] or
                not Path(item["path"]).is_absolute() or ".." in Path(item["path"]).parts or
                Path(item["path"]).suffix.lower() not in {".jpg", ".jpeg", ".png", ".gif", ".webp", ".mp4", ".mov", ".webm"} or
                not isinstance(item["mediaId"], str) or not view.UUID.fullmatch(item["mediaId"]) or item["mediaId"] in seen or
                item["kind"] not in {"image", "video"} or type(item["size"]) is not int or
                not 0 < item["size"] <= (32*1024**2 if item["kind"] == "image" else 1024**3) or
                not isinstance(item["sha256"], str) or not re.fullmatch(r"[a-f0-9]{64}", item["sha256"])):
            raise LocalPostError("invalid_media", "1~100개의 지원 이미지·영상을 선택하세요. 이미지는 32MB, 영상은 1GB까지 등록할 수 있습니다.")
        seen.add(item["mediaId"])


def signature(path):
    no_symlinks(path)
    info = path.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise LocalPostError("invalid_media", "일반 이미지·영상 파일만 등록할 수 있습니다.")
    return (*stat_signature(info), info.st_mode, info.st_nlink)


def copy_verified(item, destination, check, on_create=None):
    path = Path(item["path"])
    before = signature(path)
    if before[2] != item["size"]:
        raise LocalPostError("local_file_changed", "선택한 파일의 크기가 변경되었습니다. 다시 선택하세요.")
    digest, size = hashlib.sha256(), 0
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
    with os.fdopen(os.open(path, flags), "rb") as source, destination.open("xb") as output:
        if on_create is not None:
            info = os.fstat(output.fileno())
            on_create(destination, (info.st_dev, info.st_ino))
        opened = os.fstat(source.fileno())
        if (*stat_signature(opened), opened.st_mode, opened.st_nlink) != before:
            raise LocalPostError("local_file_changed", "선택한 파일이 변경되었습니다. 다시 선택하세요.")
        while True:
            cancelled(check)
            block = source.read(1024*1024)
            if not block:
                break
            size += len(block)
            if size > item["size"]:
                raise LocalPostError("local_file_changed", "복사 중 선택한 파일이 변경되었습니다.")
            digest.update(block)
            output.write(block)
        output.flush()
        os.fsync(output.fileno())
        current = os.fstat(source.fileno())
        if (*stat_signature(current), current.st_mode, current.st_nlink) != before:
            raise LocalPostError("local_file_changed", "복사 중 선택한 파일이 변경되었습니다.")
    if signature(path) != before or size != item["size"] or digest.hexdigest() != item["sha256"]:
        raise LocalPostError("local_file_changed", "선택한 파일이 변경되었습니다. 다시 선택하세요.")


def media_extension(path, kind, check):
    if kind == "image":
        from PIL import Image
        try:
            return _image_metadata(path, {"image": Image}, "application/octet-stream", time.monotonic()+60, check)["extension"]
        except TransferError as exc:
            cancelled(check)
            raise LocalPostError("invalid_media", "이미지 파일을 읽을 수 없거나 지원하지 않는 형식입니다.") from exc
    extension = path.suffix.lower().lstrip(".")
    if extension not in {"mp4", "mov", "webm"}:
        raise LocalPostError("invalid_media", "영상은 MP4, MOV, WebM 파일을 선택하세요.")
    executable = shutil.which("ffprobe")
    if not executable:
        raise LocalPostError("dependency_missing", "영상 검사 도구를 사용할 수 없습니다.")
    command = [str(Path(executable).resolve()), "-v", "error", "-protocol_whitelist", "file", "-format_whitelist", "mov,matroska,webm",
        "-i", str(path), "-count_packets", "-show_entries", "stream=codec_type,width,height,nb_read_packets:format=format_name", "-of", "json"]
    with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as error:
        process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=output, stderr=error, env={}, shell=False)
        try:
            deadline = time.monotonic()+60
            while process.poll() is None:
                cancelled(check)
                if time.monotonic() >= deadline:
                    raise LocalPostError("media_validation_timeout", "영상 검사가 오래 걸려 중단했습니다.")
                try:
                    process.wait(timeout=0.1)
                except subprocess.TimeoutExpired:
                    pass
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()
        try:
            if process.returncode or output.tell() > 65536 or error.tell():
                raise ValueError()
            output.seek(0)
            value = json.loads(output.read(65537))
            formats = value.get("format", {}).get("format_name", "").split(",")
            if (extension == "webm" and "webm" not in formats) or (extension != "webm" and "mov" not in formats):
                raise ValueError()
            streams = [item for item in value.get("streams", []) if item.get("codec_type") == "video"]
            if not streams or any(not 0 < int(item["width"])*int(item["height"]) <= 40_000_000 or int(item.get("nb_read_packets", 0)) < 1 for item in streams):
                raise ValueError()
        except (ValueError, KeyError, TypeError) as exc:
            raise LocalPostError("invalid_media", "영상 파일의 형식이나 영상 데이터를 확인할 수 없습니다.") from exc
    return extension


def execute(data, *, check=lambda: False):
    validate(data)
    root = collection_root(Path(data["root"]))
    require_no_pending(root)
    cancelled(check)
    with LocalPostLock(root) as lock:
        # The standard initializer refuses to recreate a lost database over existing media.
        if not safe_path(root, "state/state.db").exists():
            state = State(root)
            try:
                state._open()
            finally:
                if state.db is not None:
                    state.db.close()
        with closing(delete_media.open_db(root, "rw")) as db:
            db.execute("PRAGMA synchronous=FULL")
            db.execute("PRAGMA foreign_keys=ON")
            recover_imports(root, db, check)
            posts, stored = store.read(db)
            key = store.ACCOUNT, data["postId"]
            if key in database_deletions(root, db)[0]:
                raise LocalPostError("local_post_conflict", "이미 삭제된 개인 글입니다. 새 글로 다시 작성하세요.")
            post = {"account": key[0], "postId": key[1]}
            existing = next((item for item in posts if (item["account"], item["post_id"]) == key), None)
            if existing:
                draft = view.read_drafts(root, db=db).get(key)
                rows = [item for item in stored if (item["account"], item["post_id"]) == key]
                expected = [(item["mediaId"], item["kind"], item["size"], item["sha256"]) for item in data["files"]]
                if (not draft or draft["revision"] != 1 or draft["caption"] != data["caption"] or
                        draft["mediaIds"] != [item["mediaId"] for item in data["files"]] or
                        [(item["media_id"], item["kind"], item["size"], item["sha256"]) for item in rows] != expected):
                    raise LocalPostError("local_post_conflict", "같은 개인 글이 이미 등록되었거나 변경되었습니다.")
                for item in rows:
                    view.local_file(root, item)
                return {"ok": True, "postKey": json.dumps(key, separators=(",", ":")), "draft": draft}
            library = json.loads(db.execute("SELECT value FROM meta WHERE key='library_id'").fetchone()[0])
            folder = safe_path(root, f"media/files/{library}")
            folder.mkdir(exist_ok=True)
            temporary = safe_path(root, f"_work/local-post-{data['postId']}")
            temporary.mkdir()
            document = {"version": 1, "root": str(root), "libraryId": library, "postId": data["postId"], "files": [
                {"mediaId": item["mediaId"], "stage": item["mediaId"]+Path(item["path"]).suffix.lower(), "identity": None, "final": None,
                 "size": item["size"], "sha256": item["sha256"]}
                for item in data["files"]]}
            journal = temporary / "journal.json"
            delete_media.write_new(journal, delete_media.encoded(document))
            def save_journal():
                delete_media.write_atomic(journal, delete_media.encoded(document))
            try:
                rows = []
                for ordinal, (item, owned) in enumerate(zip(data["files"], document["files"]), 1):
                    cancelled(check)
                    identifier = item["mediaId"]
                    if (db.execute("SELECT 1 FROM media WHERE media_id=?", (identifier,)).fetchone() or
                            any(row["media_id"] == identifier for row in stored)):
                        raise LocalPostError("local_post_conflict", "선택한 첨부의 식별자가 이미 사용 중입니다.")
                    staged = temporary / owned["stage"]
                    def created(_path, identity):
                        owned["identity"] = list(identity)
                        save_journal()
                    copy_verified(item, staged, check, on_create=created)
                    extension = media_extension(staged, item["kind"], check)
                    relative = f"media/files/{library}/{identifier}.{extension}"
                    destination = safe_path(root, relative)
                    if destination.exists():
                        raise LocalPostError("local_post_conflict", "같은 식별자의 파일이 이미 있어 보존했습니다.")
                    # Journal records the already-owned inode before the exclusive
                    # hard link. A crash cannot leave an untracked final copy.
                    owned["final"] = relative
                    save_journal()
                    try:
                        os.link(staged, destination)
                    except FileExistsError:
                        owned["final"] = None
                        save_journal()
                        raise LocalPostError("local_post_conflict", "같은 식별자의 파일이 이미 있어 보존했습니다.") from None
                    staged.unlink()
                    rows.append((identifier, *key, ordinal, item["kind"], relative, item["size"], item["sha256"]))
                sync_directory(folder)
                cancelled(check)
                lock.assert_owned()
                with db:
                    db.execute("BEGIN IMMEDIATE")
                    store.create_schema(db)
                    db.execute("INSERT INTO local_posts VALUES(?,?,?)", (*key, datetime.now(timezone.utc).isoformat()))
                    db.executemany("INSERT INTO local_post_media VALUES(?,?,?,?,?,?,?,?)", rows)
                    draft = post_draft.write_draft(db, root, post, {"caption": data["caption"], "mediaIds": [item["mediaId"] for item in data["files"]], "expectedRevision": None})
                    cancelled(check)
                    require_no_pending(root)
                    lock.assert_owned()
                return {"ok": True, "postKey": json.dumps(key, separators=(",", ":")), "draft": draft}
            finally:
                recover_imports(root, db, lambda: False)


def main(argv=()):
    sys.stdout.reconfigure(encoding="utf-8")
    stopped, monitor = False, None
    def stop(*_):
        nonlocal stopped
        stopped = True
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, stop)
    try:
        monitor = ParentMonitor()
        raw = sys.stdin.buffer.read(INPUT_LIMIT+1)
        if not raw or len(raw) > INPUT_LIMIT:
            raise LocalPostError("invalid_request", "개인 글 등록 요청의 크기를 확인하세요.")
        data = parse_json(raw)
        if list(argv) == ["--recover"]:
            if not isinstance(data, dict) or set(data) != {"root"} or not isinstance(data["root"], str):
                raise LocalPostError("invalid_request", "개인 글 복구 요청을 확인하세요.")
            result = recover(data["root"], check=lambda: stopped or monitor.cancelled())
        elif argv:
            raise LocalPostError("invalid_request", "개인 글 등록 요청을 확인하세요.")
        else:
            result = execute(data, check=lambda: stopped or monitor.cancelled())
    except (LocalPostError, SourceError, StateError, MonitorError, post_draft.DraftError, delete_media.DeleteError) as exc:
        result = {"ok": False, "error": {"code": exc.code, "message": str(exc)}}
    except Exception:
        result = {"ok": False, "error": {"code": "local_post_save_failed", "message": "개인 글을 등록하지 못했습니다. 선택한 원본 파일은 보존했습니다."}}
    finally:
        if monitor is not None:
            monitor.close()
    print(json.dumps(result, ensure_ascii=False, allow_nan=False), flush=True)
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
