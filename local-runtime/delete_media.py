#!/usr/bin/env python3
"""Confirmed local deletion with a durable journal, quarantine, and tombstones."""
from __future__ import annotations

from contextlib import closing, contextmanager
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import sqlite3
import sys
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))
import collection_view as view
from threads_runner import attempts
from threads_runner.deletion_state import require_no_pending
from threads_runner.parent_monitor import MonitorError, ParentMonitor
from threads_runner.recovery import definitely_dead
from threads_runner.state import StateError
from threads_source import excel_input as excel, workbook_write as writer
from threads_source.files import CollectionLock, SourceError, collection_root, parse_json, read_stable, safe_path, sync_directory

INPUT_LIMIT = 32*1024
JOURNAL_LIMIT = 16*1024*1024
HEX = re.compile(r"[0-9a-f]{64}")
TRANSACTION = re.compile(r"delete-([0-9a-f]{32})")
PART = re.compile(r"media/\.partial/([0-9a-f]{32})\.part")
KST = timezone(timedelta(hours=9))


class DeleteError(ValueError):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


def stopped(check):
    if check(): raise DeleteError("cancelled", "삭제를 취소했습니다. 기존 자료는 보존했습니다.")


def digest(raw): return hashlib.sha256(raw).hexdigest()
def encoded(value): return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def file_record(root, relative, expected_size=None, expected_hash=None):
    path = safe_path(root, relative)
    if not path.exists():
        return {"path": relative, "exists": False, "size": expected_size, "sha256": expected_hash}
    safe_path(root, relative, require_file=True)
    before = view.stamp(path)
    checksum = hashlib.sha256()
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
    with os.fdopen(os.open(path, flags), "rb") as stream:
        info = os.fstat(stream.fileno())
        if (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns) != before:
            raise DeleteError("deletion_changed", "삭제 확인 중 파일이 변경되었습니다. 다시 확인하세요.")
        for block in iter(lambda: stream.read(1024*1024), b""):
            checksum.update(block)
    safe_path(root, relative, require_file=True)
    sha = checksum.hexdigest()
    if (view.stamp(path) != before or (expected_size is not None and before[2] != expected_size) or
            (expected_hash is not None and sha != expected_hash)):
        raise DeleteError("deletion_changed", "저장된 파일이 변경되었습니다. 파일을 확인한 뒤 다시 삭제하세요.")
    return {"path": relative, "exists": True, "size": before[2], "sha256": sha}


def open_db(root, mode="ro"):
    path = safe_path(root, "state/state.db", require_file=True)
    for suffix in ("-wal", "-shm", "-journal"):
        sidecar = safe_path(root, "state/state.db"+suffix)
        if sidecar.exists(): safe_path(root, "state/state.db"+suffix, require_file=True)
    connection = sqlite3.connect(path.as_uri()+f"?mode={mode}"+("&immutable=1" if mode == "ro" else ""), uri=True, timeout=0)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute("PRAGMA trusted_schema=OFF")
        if mode == "ro": connection.execute("PRAGMA query_only=ON")
        if (connection.execute("PRAGMA application_id").fetchone()[0] != view.APP_ID or
                connection.execute("PRAGMA user_version").fetchone()[0] != view.SCHEMA_VERSION or
                connection.execute("PRAGMA quick_check").fetchone()[0] != "ok"):
            raise DeleteError("invalid_database", "기존 상태 DB를 확인해야 합니다.")
        meta = {row[0]: json.loads(row[1]) for row in connection.execute("SELECT key,value FROM meta WHERE key IN ('root','library_id')")}
        marker = parse_json(read_stable(safe_path(root, "media/.library.json", require_file=True), max_bytes=4096))
        if meta.get("root") != str(root) or meta.get("library_id") != marker.get("library_id") or not view.UUID.fullmatch(meta.get("library_id", "")):
            raise DeleteError("library_mismatch", "기존 DB와 미디어 폴더 연결을 확인하세요.")
        return connection
    except BaseException:
        connection.close()
        raise


def has_table(db, name):
    return bool(db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone())


class DeleteLock(CollectionLock):
    def __enter__(self):
        self.path.parent.mkdir(exist_ok=True)
        try:
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
            with os.fdopen(os.open(self.path, flags, 0o600), "wb") as stream:
                self.owns_lock = True
                info = os.fstat(stream.fileno())
                self.inode = info.st_dev, info.st_ino
                stream.write(encoded({"owner": "media-delete", "token": self.token, "pid": os.getpid()}))
                stream.flush()
                os.fsync(stream.fileno())
            sync_directory(self.path.parent)
            return self
        except FileExistsError as exc:
            raise DeleteError("busy", "다른 작업이 진행 중입니다. 종료 후 삭제하세요.") from exc
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def assert_owned(self, run_id=None):
        raw = parse_json(read_stable(self.path, max_bytes=4096))
        info = self.path.stat()
        if (raw.get("owner") != "media-delete" or raw.get("token") != self.token or
                self.inode != (info.st_dev, info.st_ino)):
            raise DeleteError("busy", "삭제 작업의 잠금 연결이 변경되었습니다.")


def validate(data):
    if not isinstance(data, dict) or data.get("command") not in {"prepare", "commit", "recover"} or not isinstance(data.get("root"), str):
        raise DeleteError("invalid_request", "삭제 요청 형식이 올바르지 않습니다.")
    if data["command"] == "recover":
        if set(data) != {"command", "root"}: raise DeleteError("invalid_request", "복구 요청 형식이 올바르지 않습니다.")
        return
    fields = {"command", "root", "kind", "postKey"}
    if data.get("kind") == "edit": fields.add("mediaId")
    if data["command"] == "commit": fields.add("fingerprint")
    if (set(data) != fields or data.get("kind") not in {"post", "edit"} or
            not isinstance(data.get("postKey"), str) or len(data["postKey"]) > 512 or
            (data["kind"] == "edit" and (not isinstance(data.get("mediaId"), str) or not view.UUID.fullmatch(data["mediaId"]))) or
            (data["command"] == "commit" and (not isinstance(data["fingerprint"], str) or not HEX.fullmatch(data["fingerprint"])))):
        raise DeleteError("invalid_request", "삭제 요청 형식이 올바르지 않습니다.")


def workbook_targets(root, account, post_id):
    source = excel.load_collection(root)
    if source["errors"]:
        raise DeleteError("invalid_source", "수집 Excel 원본을 확인해야 합니다.")
    books = []
    for item in source["sources"]:
        path = safe_path(root, item["relative_path"], require_file=True)
        writer.unlocked(path)
        table = excel._read_tables(path, {"게시글": ("계정명", "게시글ID")})
        if table["errors"] or table["source_sha256"] != item["sha256"]:
            raise DeleteError("deletion_changed", "삭제 확인 중 Excel 원본이 변경되었습니다.")
        rows = [row["_row"] for row in table["게시글"] if (row["계정명"], row["게시글ID"]) == (account, post_id)]
        if rows: books.append({"path": item["relative_path"], "sha256": item["sha256"], "rows": rows})
    return books


def plan(root, data, lock=None):
    require_no_pending(root)
    snapshot = view.read_snapshot(root, owned_lock=lock)
    if snapshot["snapshot"]["stateStatus"] != "read_only":
        raise DeleteError("deletion_state_unavailable", "기존 저장 상태 DB를 확인한 뒤 삭제하세요.")
    if any(item.get("code") == "drafts_unavailable" for item in snapshot["snapshot"].get("warnings", [])):
        raise DeleteError("drafts_unavailable", "등록 초안의 파일 선택 정보를 읽을 수 없습니다. 기존 초안을 확인한 뒤 삭제하세요.")
    post = next((p for p in snapshot["snapshot"]["posts"] if p["key"] == data["postKey"]), None)
    if not post: raise DeleteError("post_missing", "게시글을 찾을 수 없습니다. 목록을 새로고침하세요.")
    if data["kind"] == "edit" and data["mediaId"] in post.get("draft", {}).get("mediaIds", []):
        raise DeleteError("draft_media_in_use", "등록 초안에 포함된 편집본입니다. 초안을 수정해 이 항목을 뺀 뒤 삭제하세요.")
    files, edits, jobs = {}, [], []
    with closing(open_db(root)) as db:
        if data["kind"] == "post":
            retired = attempts.retired_ids(db)
            if any(row['job_id'] not in retired for row in db.execute(
                    "SELECT job_id FROM jobs WHERE status IN ('planned','running','staged')")):
                raise DeleteError("pending_download_plan", "미완료 다운로드 계획이 있습니다. 계획을 완료·확인한 뒤 게시글을 삭제하세요.")
        library = json.loads(db.execute("SELECT value FROM meta WHERE key='library_id'").fetchone()[0])
        removed = {row[0] for row in db.execute("SELECT edit_id FROM edit_deletions")} if has_table(db, "edit_deletions") else set()
        if has_table(db, "media_edits"):
            edits = [dict(row) for row in db.execute("SELECT * FROM media_edits WHERE account=? AND post_id=? ORDER BY sequence", (post["account"], post["postId"])) if row["edit_id"] not in removed]
        if data["kind"] == "edit":
            edits = [row for row in edits if row["edit_id"] == data["mediaId"]]
            if len(edits) != 1:
                raise DeleteError("edit_missing", "삭제할 편집본을 찾을 수 없습니다. 원본은 삭제하지 않았습니다.")
        else:
            jobs = [dict(row) for row in db.execute("SELECT j.*,m.kind FROM jobs j JOIN media m USING(media_id) WHERE m.account=? AND m.post_id=? ORDER BY j.job_id", (post["account"], post["postId"]))]
        for row in edits:
            media_format = view.EDIT_FORMAT.get(row['edit_type'])
            if (not media_format or not view.UUID.fullmatch(row["edit_id"]) or
                    row["final_rel"] != f"media/files/{library}/{row['edit_id']}.{media_format[1]}" or
                    type(row["size"]) is not int or row["size"] < 1 or not HEX.fullmatch(row["sha256"] or "")):
                raise DeleteError("invalid_edit", "편집 파일의 저장 경로를 확인해야 합니다.")
            files[row["final_rel"]] = file_record(root, row["final_rel"], row["size"], row["sha256"])
        for row in jobs:
            if row["final_rel"]:
                match = view.FILE.fullmatch(row["final_rel"])
                if not match or match[1] != row["media_id"] or row["size"] is None or not HEX.fullmatch(row["sha256"] or ""):
                    raise DeleteError("invalid_local_path", "원본 파일의 저장 연결을 확인해야 합니다.")
                files[row["final_rel"]] = file_record(root, row["final_rel"], row["size"], row["sha256"])
            if row["part_rel"]:
                if row["part_rel"] != f"media/.partial/{row['job_id']}.part" or not view.UUID.fullmatch(row["job_id"]):
                    raise DeleteError("invalid_local_path", "미완료 파일의 연결을 확인해야 합니다.")
                files[row["part_rel"]] = file_record(root, row["part_rel"])
    result = {"kind": data["kind"], "postKey": data["postKey"], "account": post["account"], "postId": post["postId"],
        "mediaId": data.get("mediaId"), "libraryId": library, "draft": post.get("draft"), "files": sorted(files.values(), key=lambda item: item["path"]),
        "books": workbook_targets(root, post["account"], post["postId"]) if data["kind"] == "post" else [],
        "edits": edits, "jobs": jobs}
    result["fingerprint"] = digest(encoded(result))
    return result


def write_new(path, raw):
    with path.open("xb") as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    sync_directory(path.parent)


def write_atomic(path, raw):
    temporary = path.with_name(".delete-restore-"+uuid.uuid4().hex)
    try:
        write_new(temporary, raw)
        os.replace(temporary, path)
        sync_directory(path.parent)
    finally:
        if temporary.exists(): temporary.unlink()


def prepare_journal(root, current, lock, check):
    transaction = uuid.uuid4().hex
    folder = safe_path(root, f"_work/delete-{transaction}")
    folder.mkdir()
    document = {"version": 1, "id": transaction, "root": str(root), "libraryId": current["libraryId"],
        "lockToken": lock.token, "kind": current["kind"], "account": current["account"], "postId": current["postId"],
        "mediaId": current["mediaId"], "fingerprint": current["fingerprint"],
        "deletedAt": datetime.now(KST).isoformat(), "files": [], "books": []}
    try:
        for index, item in enumerate(current["books"]):
            stopped(check)
            path = safe_path(root, item["path"], require_file=True)
            before = read_stable(path, max_bytes=excel.MAX_ARCHIVE_BYTES)
            if digest(before) != item["sha256"]: raise DeleteError("deletion_changed", "삭제 확인 후 Excel이 변경되었습니다.")
            updated = writer.patch_workbook(before, {"게시글": [(row, {"삭제여부": "Y", "삭제시각(KST)": document["deletedAt"]}) for row in item["rows"]]})
            backup, replacement = f"book-{index}.before", f"book-{index}.after"
            write_new(folder/backup, before)
            write_new(folder/replacement, updated)
            checked = excel.read_workbook(folder/replacement)
            old = excel.read_workbook(path)
            for key in ("posts", "media", "runs", "errors"):
                if checked[key] != old[key]: raise DeleteError("workbook_changed", "삭제 표시 외 Excel 원문이 바뀌어 중단했습니다.")
            document["books"].append({"path": item["path"], "before": item["sha256"], "after": digest(updated), "backup": backup, "replacement": replacement})
        for item in current["files"]:
            if item["exists"]:
                document["files"].append({"path": item["path"], "size": item["size"], "sha256": item["sha256"], "slot": f"file-{len(document['files'])}.bin"})
        # A killed write must never leave a visible partial journal blocking recovery.
        write_atomic(folder/"journal.json", encoded(document))
        sync_directory(folder.parent)
        return folder, document
    except BaseException:
        # No original has moved yet, and this newly-created directory contains only our backups.
        for path in list(folder.iterdir()):
            if path.is_file() and not path.is_symlink(): path.unlink()
        folder.rmdir()
        raise


def operations_table(db):
    db.execute("CREATE TABLE IF NOT EXISTS deletion_operations(id TEXT PRIMARY KEY,journal_sha256 TEXT NOT NULL,status TEXT NOT NULL)")


def register_operation(root, document):
    with closing(open_db(root, "rw")) as db, db:
        operations_table(db)
        db.execute("INSERT INTO deletion_operations VALUES(?,?,?)", (document["id"], digest(encoded(document)), "prepared"))


def operation_status(root, document):
    # Recovery must see a commit left in WAL, and let SQLite resolve a hot journal.
    # Immutable reads are reserved for the normal, idle prepare path.
    with closing(open_db(root, "rw")) as db:
        if not has_table(db, "deletion_operations"): return None
        row = db.execute("SELECT * FROM deletion_operations WHERE id=?", (document["id"],)).fetchone()
        if not row: return None
        if row["journal_sha256"] != digest(encoded(document)) or row["status"] not in {"prepared", "committed", "rolled_back"}:
            raise DeleteError("deletion_recovery_required", "삭제 복구 기록이 변경되었습니다. 파일을 보존하고 확인하세요.")
        return row["status"]


def apply_tombstone(root, document):
    with closing(open_db(root, "rw")) as db, db:
        if document["kind"] == "post":
            # The draft belongs to the approved whole-post deletion. Keep removal
            # in the same transaction as the tombstone and commit receipt.
            view.read_drafts(root, db=db)
            if view.draft_schema(db):
                db.execute("DELETE FROM post_drafts WHERE account=? AND post_id=?", (document["account"], document["postId"]))
            db.execute("CREATE TABLE IF NOT EXISTS post_deletions(account TEXT NOT NULL,post_id TEXT NOT NULL,deleted_at TEXT NOT NULL,PRIMARY KEY(account,post_id))")
            db.execute("INSERT INTO post_deletions VALUES(?,?,?)", (document["account"], document["postId"], document["deletedAt"]))
        else:
            db.execute("CREATE TABLE IF NOT EXISTS edit_deletions(edit_id TEXT PRIMARY KEY,deleted_at TEXT NOT NULL)")
            db.execute("INSERT INTO edit_deletions VALUES(?,?)", (document["mediaId"], document["deletedAt"]))
        db.execute("UPDATE deletion_operations SET status='committed' WHERE id=? AND journal_sha256=? AND status='prepared'", (document["id"], digest(encoded(document))))
        if db.execute("SELECT changes()").fetchone()[0] != 1:
            raise DeleteError("deletion_recovery_required", "삭제 작업 기록의 상태를 확인해야 합니다.")


def validate_journal(root, folder):
    match = TRANSACTION.fullmatch(folder.name)
    if not match: raise DeleteError("invalid_journal", "삭제 복구 폴더를 확인해야 합니다.")
    document = parse_json(read_stable(safe_path(root, f"_work/{folder.name}/journal.json", require_file=True), max_bytes=JOURNAL_LIMIT))
    if (not isinstance(document, dict) or document.get("version") != 1 or document.get("id") != match[1] or
            document.get("root") != str(root) or document.get("kind") not in {"post", "edit"} or
            not isinstance(document.get("files"), list) or not isinstance(document.get("books"), list)):
        raise DeleteError("invalid_journal", "삭제 복구 기록을 확인해야 합니다.")
    marker = parse_json(read_stable(safe_path(root, "media/.library.json", require_file=True), max_bytes=4096))
    if document.get("libraryId") != marker.get("library_id"):
        raise DeleteError("invalid_journal", "삭제 복구 자료와 라이브러리 연결이 다릅니다.")
    paths = set()
    for index, item in enumerate(document["files"]):
        if (not isinstance(item, dict) or item.get("slot") != f"file-{index}.bin" or
                not isinstance(item.get("path"), str) or not (view.FILE.fullmatch(item["path"]) or PART.fullmatch(item["path"])) or
                type(item.get("size")) is not int or item["size"] < 0 or not HEX.fullmatch(item.get("sha256", "")) or item["path"] in paths):
            raise DeleteError("invalid_journal", "삭제 복구 파일 경로가 올바르지 않습니다.")
        safe_path(root, item["path"])
        paths.add(item["path"])
    for index, item in enumerate(document["books"]):
        if (not isinstance(item, dict) or item.get("backup") != f"book-{index}.before" or item.get("replacement") != f"book-{index}.after" or
                not isinstance(item.get("path"), str) or not excel.SOURCE_RE.fullmatch(item["path"]) or
                not HEX.fullmatch(item.get("before", "")) or not HEX.fullmatch(item.get("after", "")) or item["path"] in paths):
            raise DeleteError("invalid_journal", "삭제 복구 Excel 경로가 올바르지 않습니다.")
        safe_path(root, item["path"])
        paths.add(item["path"])
    return document


def clean_journal(root, folder, document):
    allowed = {"journal.json", *(item["slot"] for item in document["files"]),
               *(item[key] for item in document["books"] for key in ("backup", "replacement"))}
    if any(path.name not in allowed or path.is_symlink() or not path.is_file() for path in folder.iterdir()):
        raise DeleteError("deletion_recovery_required", "삭제 임시 폴더에 확인되지 않은 파일이 있어 보존했습니다.")
    for item in document["books"]:
        for key, expected in (("backup", item["before"]), ("replacement", item["after"])):
            path = folder/item[key]
            if path.exists():
                if digest(read_stable(path, max_bytes=excel.MAX_ARCHIVE_BYTES)) != expected:
                    raise DeleteError("deletion_recovery_required", "삭제 복구 Excel 사본이 변경되어 보존했습니다.")
                path.unlink()
    for item in document["files"]:
        path = folder/item["slot"]
        if path.exists():
            file_record(root, path.relative_to(root).as_posix(), item["size"], item["sha256"])
            path.unlink()
    (folder/"journal.json").unlink()
    folder.rmdir()
    sync_directory(folder.parent)


def rollback(root, folder, document, lock):
    for item in document["books"]:
        lock.assert_owned()
        path = safe_path(root, item["path"], require_file=True)
        current = digest(read_stable(path, max_bytes=excel.MAX_ARCHIVE_BYTES))
        if current == item["before"]: continue
        if current != item["after"]:
            raise DeleteError("deletion_recovery_required", "삭제 후 Excel이 외부에서 변경되어 자동 복원하지 않았습니다.")
        writer.unlocked(path)
        backup = read_stable(folder/item["backup"], max_bytes=excel.MAX_ARCHIVE_BYTES)
        if digest(backup) != item["before"]: raise DeleteError("deletion_recovery_required", "삭제 복구 Excel 사본을 확인해야 합니다.")
        write_atomic(path, backup)
    for item in document["files"]:
        lock.assert_owned()
        original = safe_path(root, item["path"])
        slot = safe_path(root, (folder/item["slot"]).relative_to(root).as_posix())
        if original.exists():
            file_record(root, item["path"], item["size"], item["sha256"])
        elif slot.exists():
            file_record(root, slot.relative_to(root).as_posix(), item["size"], item["sha256"])
            os.replace(slot, original)
            sync_directory(original.parent)
        else:
            raise DeleteError("deletion_recovery_required", "복원할 파일을 찾을 수 없습니다. 삭제 복구 자료를 보존했습니다.")
    with closing(open_db(root, "rw")) as db, db:
        if has_table(db, "deletion_operations"):
            db.execute("UPDATE deletion_operations SET status='rolled_back' WHERE id=?", (document["id"],))
    clean_journal(root, folder, document)


def finish_committed(root, folder, document, lock):
    for item in document["books"]:
        if digest(read_stable(safe_path(root, item["path"], require_file=True), max_bytes=excel.MAX_ARCHIVE_BYTES)) != item["after"]:
            raise DeleteError("deletion_recovery_required", "삭제 표시 Excel이 변경되었습니다. 삭제 복구 자료를 보존했습니다.")
    for item in document["files"]:
        lock.assert_owned()
        # Only quarantined files are deleted; a newly-created source path is never touched.
        slot = folder/item["slot"]
        if slot.exists(): file_record(root, slot.relative_to(root).as_posix(), item["size"], item["sha256"])
    clean_journal(root, folder, document)


def commit(root, data, check):
    with DeleteLock(root) as lock:
        current = plan(root, data, lock)
        if current["fingerprint"] != data["fingerprint"]:
            raise DeleteError("deletion_changed", "확인창을 연 뒤 삭제 대상이 변경되었습니다. 다시 확인하세요.")
        stopped(check)
        folder, document = prepare_journal(root, current, lock, check)
        try:
            register_operation(root, document)
            for item in document["files"]:
                lock.assert_owned()
                stopped(check)
                file_record(root, item["path"], item["size"], item["sha256"])
                os.replace(safe_path(root, item["path"], require_file=True), folder/item["slot"])
                sync_directory(folder)
                sync_directory((root/item["path"]).parent)
            for item in document["books"]:
                lock.assert_owned()
                stopped(check)
                path = safe_path(root, item["path"], require_file=True)
                writer.unlocked(path)
                if digest(read_stable(path, max_bytes=excel.MAX_ARCHIVE_BYTES)) != item["before"]:
                    raise DeleteError("deletion_changed", "삭제 중 Excel 원본이 변경되었습니다.")
                raw = read_stable(folder/item["replacement"], max_bytes=excel.MAX_ARCHIVE_BYTES)
                if digest(raw) != item["after"]: raise DeleteError("deletion_changed", "삭제 표시 Excel 사본이 변경되었습니다.")
                write_atomic(path, raw)
            stopped(check)
            lock.assert_owned()
            apply_tombstone(root, document)
        except BaseException:
            # The DB receipt resolves uncertain commit outcomes; never undo a committed deletion.
            if operation_status(root, document) == "committed":
                finish_committed(root, folder, document, lock)
                return {"ok": True}
            try:
                rollback(root, folder, document, lock)
            except BaseException as recovery_error:
                raise DeleteError("deletion_recovery_required", "삭제를 완료하지 못했습니다. '삭제 작업 복구'로 기존 자료를 복원하세요.") from recovery_error
            raise
        finish_committed(root, folder, document, lock)
        return {"ok": True}


def release_dead_lock(root):
    lock = safe_path(root, "_work/collector.lock")
    if not lock.exists(): return
    before = read_stable(safe_path(root, "_work/collector.lock", require_file=True), max_bytes=4096)
    data = parse_json(before)
    if (data.get("owner") != "media-delete" or not view.UUID.fullmatch(str(data.get("token", ""))) or not definitely_dead(data.get("pid"))):
        raise DeleteError("busy", "진행 중이거나 다른 작업의 잠금은 해제하지 않습니다.")
    if read_stable(lock, max_bytes=4096) != before:
        raise DeleteError("busy", "삭제 잠금이 변경되어 보존했습니다.")
    lock.unlink()
    sync_directory(lock.parent)


@contextmanager
def recovery_guard(root):
    """An OS lock serializes dead-lock removal and releases even after SIGKILL."""
    path = safe_path(root, "_work/delete-recovery.guard")
    path.parent.mkdir(exist_ok=True)
    if path.exists(): safe_path(root, path.relative_to(root).as_posix(), require_file=True)
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
    with os.fdopen(os.open(path, flags, 0o600), "r+b") as stream:
        safe_path(root, path.relative_to(root).as_posix(), require_file=True)
        if os.fstat(stream.fileno()).st_size == 0:
            stream.write(b"0")
            stream.flush()
        stream.seek(0)
        if os.name == "nt":
            import msvcrt
            take = lambda: msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            release = lambda: msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            take = lambda: fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            release = lambda: fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
        try:
            take()
        except OSError as exc:
            raise DeleteError("busy", "다른 삭제 복구가 진행 중입니다.") from exc
        try:
            yield
        finally:
            release()


def recover(root):
    with recovery_guard(root):
        return recover_owned(root)


def recover_owned(root):
    release_dead_lock(root)
    recovered = 0
    with DeleteLock(root) as lock:
        for folder in sorted((root/"_work").glob("delete-*")):
            if not TRANSACTION.fullmatch(folder.name) or not (folder/"journal.json").exists(): continue
            document = validate_journal(root, folder)
            status = operation_status(root, document)
            if status == "committed":
                finish_committed(root, folder, document, lock)
            else:
                if status is None:
                    # The worker never moves originals before registering its journal in SQLite.
                    if any((folder/item["slot"]).exists() for item in document["files"]):
                        raise DeleteError("deletion_recovery_required", "삭제 복구 기록과 DB 연결을 확인해야 합니다.")
                    for item in document["books"]:
                        if digest(read_stable(safe_path(root, item["path"], require_file=True), max_bytes=excel.MAX_ARCHIVE_BYTES)) != item["before"]:
                            raise DeleteError("deletion_recovery_required", "등록되지 않은 삭제 복구 기록을 보존했습니다.")
                    for item in document["files"]:
                        if not file_record(root, item["path"], item["size"], item["sha256"])["exists"]:
                            raise DeleteError("deletion_recovery_required", "등록되지 않은 삭제 복구 기록의 원본이 없어 보존했습니다.")
                    clean_journal(root, folder, document)
                else:
                    rollback(root, folder, document, lock)
            recovered += 1
    return {"ok": True, "recovered": recovered}


def execute(data, *, check=lambda: False):
    validate(data)
    root = collection_root(Path(data["root"]))
    stopped(check)
    if data["command"] == "recover": return recover(root)
    if data["command"] == "commit": return commit(root, data, check)
    current = plan(root, data)
    return {"ok": True, "fingerprint": current["fingerprint"],
            "fileCount": sum(item["exists"] for item in current["files"]), "editCount": len(current["edits"]),
            "account": current["account"], "postId": current["postId"]}


def main():
    stopped_flag = False
    monitor = None
    def stop(*_):
        nonlocal stopped_flag
        stopped_flag = True
    for sig in (signal.SIGTERM, signal.SIGINT): signal.signal(sig, stop)
    try:
        monitor = ParentMonitor()
        raw = sys.stdin.buffer.read(INPUT_LIMIT+1)
        if not raw or len(raw) > INPUT_LIMIT: raise DeleteError("invalid_request", "삭제 요청 크기나 형식을 확인하세요.")
        result = execute(parse_json(raw), check=lambda: stopped_flag or monitor.cancelled())
    except (DeleteError, SourceError, excel.InputError, StateError, MonitorError) as exc:
        result = {"ok": False, "error": {"code": exc.code, "message": str(exc)}}
    except Exception:
        result = {"ok": False, "error": {"code": "delete_failed", "message": "삭제를 완료하지 못했습니다. 자료 상태와 삭제 복구 안내를 확인하세요."}}
    finally:
        if monitor is not None: monitor.close()
    print(json.dumps(result, ensure_ascii=False, allow_nan=False), flush=True)
    return 0 if result["ok"] else 1


if __name__ == "__main__": sys.exit(main())
