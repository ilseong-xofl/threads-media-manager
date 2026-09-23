#!/usr/bin/env python3
"""One local publication draft per original post; ordered file references only."""
from __future__ import annotations

from contextlib import closing
from datetime import datetime, timezone
import argparse
import json
from pathlib import Path
import signal
import sqlite3
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import collection_view as view
from export_post import stable_snapshot
from threads_runner.deletion_state import database_deletions, require_no_pending
from threads_runner.parent_monitor import MonitorError, ParentMonitor
from threads_runner.state import StateError
from threads_source.files import CollectionLock, SourceError, collection_root, parse_json, read_stable, safe_path

INPUT_LIMIT = 128 * 1024


class DraftError(ValueError):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


def cancelled(check):
    if check(): raise DraftError("cancelled", "등록 초안 작업을 취소했습니다.")


def validate(data):
    deleting = isinstance(data, dict) and data.get("kind") == "delete"
    fields = {"root", "postKey", "kind", "expectedRevision"} if deleting else {"root", "postKey", "caption", "mediaIds", "expectedRevision"}
    if (not isinstance(data, dict) or set(data) != fields or
            not isinstance(data.get("root"), str) or not data["root"] or
            not isinstance(data.get("postKey"), str) or not data["postKey"] or len(data["postKey"]) > 512):
        raise DraftError("invalid_request", "등록 초안 저장 요청이 올바르지 않습니다.")
    if not deleting:
        try:
            view.draft_caption(data["caption"])
            view.draft_media_ids(data["mediaIds"])
        except (ValueError, TypeError) as exc:
            raise DraftError("invalid_draft", "문구는 10,000자 이내로 입력하고, 중복 없이 1~100개의 미디어를 선택하세요.") from exc
    revision = data["expectedRevision"]
    if (deleting and revision is None) or (revision is not None and (type(revision) is not int or not 1 <= revision <= view.MAX_DRAFT_REVISION)):
        raise DraftError("invalid_request", "등록 초안의 수정 버전을 확인하세요.")


def check_revision(draft, expected):
    if (draft is None and expected is not None) or (draft is not None and draft["revision"] != expected):
        raise DraftError("draft_conflict", "다른 화면에서 초안이 변경되었습니다. 최신 초안을 다시 열어 수정하세요.")


def selected_post(snapshot, data):
    if snapshot["snapshot"]["stateStatus"] != "read_only":
        raise DraftError("draft_state_unavailable", "기존 저장 상태 DB를 확인한 뒤 등록 초안을 저장하세요.")
    if any(item.get("code") == "drafts_unavailable" for item in snapshot["snapshot"].get("warnings", [])):
        raise DraftError("drafts_unavailable", "기존 등록 초안을 읽을 수 없습니다. 덮어쓰지 않도록 저장 상태를 먼저 확인하세요.")
    matches = [post for post in snapshot["snapshot"]["posts"] if post["key"] == data["postKey"]]
    if len(matches) != 1:
        raise DraftError("post_missing", "게시글을 찾을 수 없습니다. 목록을 새로고침하세요.")
    post = matches[0]
    check_revision(post.get("draft"), data["expectedRevision"])
    if data.get("kind") == "delete":
        # Removing a draft releases references only; a missing media file must
        # not make a registered draft impossible to remove.
        return post
    attachments = {item.get("mediaId"): item for item in [*post["attachments"], *post.get("edits", []), *post.get("aiImages", [])] if item.get("mediaId")}
    registered = {item["id"]: item for item in snapshot["files"]}
    for media_id in data["mediaIds"]:
        item, file = attachments.get(media_id), registered.get(media_id)
        if (not item or not file or item.get("status") != "saved" or item.get("kind") not in {"image", "video"} or
                item["kind"] != file["kind"]):
            raise DraftError("draft_media_unavailable", "이 게시글에 저장된 이미지·영상만 선택할 수 있습니다. 누락된 항목을 빼거나 저장 상태를 확인하세요.")
    return post


def write_draft(db, root, post, data):
    try: existing = view.read_drafts(root, db=db).get((post["account"], post["postId"]))
    except (ValueError, sqlite3.Error, TypeError) as exc:
        raise DraftError("drafts_unavailable", "기존 등록 초안의 저장 형식을 확인하세요.") from exc
    check_revision(existing, data["expectedRevision"])
    if existing and existing["revision"] == view.MAX_DRAFT_REVISION:
        raise DraftError("draft_revision_limit", "등록 초안의 수정 버전 상한을 확인해야 합니다.")
    now = datetime.now(timezone.utc)
    if existing: now = max(now, datetime.fromisoformat(existing["updatedAt"]))
    updated = now.isoformat()
    draft = {"caption": data["caption"], "mediaIds": list(data["mediaIds"]),
        "createdAt": existing["createdAt"] if existing else updated, "updatedAt": updated,
        "revision": existing["revision"]+1 if existing else 1}
    if not view.draft_schema(db):
        db.execute("""CREATE TABLE post_drafts(
            account TEXT NOT NULL,post_id TEXT NOT NULL,caption TEXT NOT NULL,media_ids_json TEXT NOT NULL,
            created_at TEXT NOT NULL,updated_at TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),
            PRIMARY KEY(account,post_id))""")
    values = (draft["caption"], json.dumps(draft["mediaIds"], separators=(",", ":")), draft["updatedAt"], draft["revision"], post["account"], post["postId"])
    if existing:
        changed = db.execute("""UPDATE post_drafts SET caption=?,media_ids_json=?,updated_at=?,revision=?
            WHERE account=? AND post_id=? AND revision=?""", (*values, data["expectedRevision"])).rowcount
        if changed != 1: raise DraftError("draft_conflict", "등록 초안이 변경되었습니다. 최신 초안을 다시 열어 수정하세요.")
    else:
        try:
            db.execute("""INSERT INTO post_drafts(caption,media_ids_json,updated_at,revision,account,post_id,created_at)
                VALUES(?,?,?,?,?,?,?)""", (*values, draft["createdAt"]))
        except sqlite3.IntegrityError as exc:
            raise DraftError("draft_conflict", "등록 초안이 이미 저장되었습니다. 최신 초안을 다시 열어 수정하세요.") from exc
    return draft


def delete_draft(db, root, post, data):
    try: existing = view.read_drafts(root, db=db).get((post["account"], post["postId"]))
    except (ValueError, sqlite3.Error, TypeError) as exc:
        raise DraftError("drafts_unavailable", "기존 등록 초안의 저장 형식을 확인하세요.") from exc
    check_revision(existing, data["expectedRevision"])
    changed = db.execute("DELETE FROM post_drafts WHERE account=? AND post_id=? AND revision=?",
        (post["account"], post["postId"], data["expectedRevision"])).rowcount
    if changed != 1:
        raise DraftError("draft_conflict", "등록 초안이 변경되었습니다. 최신 초안을 다시 열어 확인하세요.")


def execute(data, *, check=lambda: False, include_ai=False):
    validate(data)
    root = collection_root(Path(data["root"]))
    require_no_pending(root)
    cancelled(check)
    with CollectionLock(root) as lock:
        snapshot = view.read_snapshot(root, owned_lock=lock, include_ai=include_ai)
        post = selected_post(snapshot, data)
        cancelled(check)
        marker = parse_json(read_stable(safe_path(root, "media/.library.json", require_file=True), max_bytes=4096))
        library = marker.get("library_id")
        if not isinstance(library, str) or not view.UUID.fullmatch(library):
            raise DraftError("invalid_library", "미디어 폴더 연결을 확인하세요.")
        current = view.read_snapshot(root, owned_lock=lock, include_ai=include_ai)
        selected_post(current, data)
        if stable_snapshot(current) != stable_snapshot(snapshot):
            raise DraftError("source_changed", "저장하는 동안 게시글이나 파일 정보가 변경되었습니다. 다시 확인하세요.")
        path = safe_path(root, "state/state.db", require_file=True)
        before = path.stat()
        with closing(sqlite3.connect(path.as_uri()+"?mode=rw", uri=True, timeout=0)) as db:
            db.execute("PRAGMA trusted_schema=OFF")
            db.execute("PRAGMA synchronous=FULL")
            if (db.execute("PRAGMA application_id").fetchone()[0] != view.APP_ID or
                    db.execute("PRAGMA user_version").fetchone()[0] != view.SCHEMA_VERSION):
                raise DraftError("invalid_database", "기존 상태 DB를 확인해야 합니다.")
            with db:
                db.execute("BEGIN IMMEDIATE")
                meta = {key: json.loads(value) for key, value in db.execute("SELECT key,value FROM meta WHERE key IN ('root','library_id')")}
                if meta != {"root": str(root), "library_id": library}:
                    raise DraftError("library_mismatch", "기존 DB와 미디어 폴더의 연결이 바뀌었습니다.")
                deleted, _ = database_deletions(root, db)
                if (post["account"], post["postId"]) in deleted:
                    raise DraftError("post_missing", "삭제된 게시글에는 등록 초안을 저장할 수 없습니다.")
                cancelled(check)
                if data.get("kind") == "delete":
                    delete_draft(db, root, post, data)
                    result = {"ok": True, "postKey": data["postKey"], "deleted": True}
                else:
                    draft = write_draft(db, root, post, data)
                    result = {"ok": True, "postKey": data["postKey"], "draft": draft}
                safe_path(root, "state/state.db", require_file=True)
                current_stat = path.stat()
                if (before.st_dev, before.st_ino) != (current_stat.st_dev, current_stat.st_ino):
                    raise DraftError("state_changed", "저장하는 동안 DB 파일이 변경되었습니다.")
                require_no_pending(root)
                lock.assert_owned()
                cancelled(check)
        return result


def main(argv=()):
    parser = argparse.ArgumentParser()
    parser.add_argument("--include-ai", action="store_true")
    args = parser.parse_args(argv)
    stopped = False
    monitor = None
    data = None
    def stop(*_):
        nonlocal stopped
        stopped = True
    for sig in (signal.SIGTERM, signal.SIGINT): signal.signal(sig, stop)
    try:
        monitor = ParentMonitor()
        raw = sys.stdin.buffer.read(INPUT_LIMIT+1)
        if not raw or len(raw) > INPUT_LIMIT:
            raise DraftError("invalid_request", "등록 초안 저장 요청의 크기나 형식을 확인하세요.")
        data = parse_json(raw)
        result = execute(data, check=lambda: stopped or monitor.cancelled(), include_ai=args.include_ai)
    except (DraftError, SourceError, view.InputError, StateError, MonitorError) as exc:
        result = {"ok": False, "error": {"code": exc.code, "message": str(exc)}}
    except Exception:
        deleting = isinstance(data, dict) and data.get("kind") == "delete"
        result = {"ok": False, "error": {"code": "draft_delete_failed" if deleting else "draft_save_failed",
            "message": "등록 초안을 삭제하지 못했습니다. 기존 자료는 보존했습니다." if deleting else "등록 초안을 저장하지 못했습니다. 기존 자료는 보존했습니다."}}
    finally:
        if monitor is not None: monitor.close()
    print(json.dumps(result, ensure_ascii=False, allow_nan=False), flush=True)
    return 0 if result["ok"] else 1


if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
