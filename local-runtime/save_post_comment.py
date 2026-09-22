#!/usr/bin/env python3
"""Store a post's local reply draft. No posting, remote lookup, or source changes."""
from __future__ import annotations

from contextlib import closing
from datetime import datetime, timezone
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
COLUMNS = ("account", "post_id", "caption", "link", "updated_at")


class CommentError(ValueError):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


def cancelled(check):
    if check(): raise CommentError("cancelled", "댓글 정보 저장을 취소했습니다.")


def text_length(value):
    try: return len(value.encode("utf-16-le"))//2
    except UnicodeError as exc:
        raise CommentError("invalid_comment", "댓글 내용의 문자 형식을 확인하세요.") from exc


def validate(data):
    if (not isinstance(data, dict) or set(data) != {"root", "postKey", "caption", "link"} or
            not all(isinstance(value, str) for value in data.values()) or not data["root"] or
            not data["postKey"] or text_length(data["postKey"]) > 512):
        raise CommentError("invalid_request", "댓글 정보 저장 요청이 올바르지 않습니다.")
    caption, link = data["caption"].strip(), data["link"].strip()
    if (text_length(caption) > 10000 or text_length(link) > 2048 or not (caption or link) or
            any(ord(char) < 32 and char not in "\t\n\r" for char in caption) or "\x7f" in caption):
        raise CommentError("invalid_comment", "댓글 내용은 10,000자, 링크는 2,048자 이내이며 하나 이상 입력해야 합니다.")
    if link:
        try:
            view.validate_comment_link(link)
        except ValueError as exc:
            raise CommentError("invalid_comment_link", "링크는 계정 정보가 없는 올바른 http 또는 https 주소여야 합니다.") from exc
    return caption, link


def selected_post(snapshot, key):
    if snapshot["snapshot"]["stateStatus"] != "read_only":
        raise CommentError("comment_state_unavailable", "기존 저장 상태 DB를 확인한 뒤 댓글 정보를 저장하세요.")
    if any(warning.get("code") == "comments_unavailable" for warning in snapshot["snapshot"].get("warnings", [])):
        raise CommentError("comments_unavailable", "기존 댓글 정보를 읽을 수 없습니다. 덮어쓰지 않도록 저장 상태를 먼저 확인하세요.")
    if any(warning.get("code") == "drafts_unavailable" for warning in snapshot["snapshot"].get("warnings", [])):
        raise CommentError("drafts_unavailable", "등록 게시글을 확인하지 못했습니다. 새로고침한 뒤 댓글을 저장하세요.")
    matches = [post for post in snapshot["snapshot"]["posts"] if post["key"] == key]
    if len(matches) != 1:
        raise CommentError("post_missing", "게시글을 찾을 수 없습니다. 목록을 새로고침하세요.")
    post = matches[0]
    if not post.get("draft"):
        raise CommentError("comment_draft_missing", "게시글을 등록한 뒤 댓글 정보를 저장하세요.")
    return post


def write_comment(db, post, comment):
    exists = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='post_comments'").fetchone()
    if exists:
        if (tuple(row[1] for row in db.execute("PRAGMA table_info(post_comments)")) != COLUMNS or
                db.execute("SELECT 1 FROM sqlite_master WHERE type='trigger' AND tbl_name='post_comments'").fetchone()):
            raise CommentError("comments_unavailable", "기존 댓글 테이블의 형식을 확인해야 합니다. 기존 정보는 보존했습니다.")
    else:
        db.execute("""CREATE TABLE post_comments(
            account TEXT NOT NULL,post_id TEXT NOT NULL,caption TEXT NOT NULL,
            link TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(account,post_id))""")
    db.execute("""INSERT INTO post_comments(account,post_id,caption,link,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(account,post_id) DO UPDATE SET caption=excluded.caption,link=excluded.link,updated_at=excluded.updated_at""",
        (post["account"], post["postId"], comment["caption"], comment["link"], comment["updatedAt"]))


def execute(data, *, check=lambda: False):
    caption, link = validate(data)
    root = collection_root(Path(data["root"]))
    require_no_pending(root)
    cancelled(check)
    with CollectionLock(root) as lock:
        snapshot = view.read_snapshot(root, owned_lock=lock)
        post = selected_post(snapshot, data["postKey"])
        cancelled(check)
        marker = parse_json(read_stable(safe_path(root, "media/.library.json", require_file=True), max_bytes=4096))
        library = marker.get("library_id")
        if not isinstance(library, str) or not view.UUID.fullmatch(library):
            raise CommentError("invalid_library", "미디어 폴더 연결을 확인하세요.")
        if stable_snapshot(view.read_snapshot(root, owned_lock=lock)) != stable_snapshot(snapshot):
            raise CommentError("source_changed", "저장하는 동안 게시글 정보가 변경되었습니다. 다시 확인하세요.")
        db_path = safe_path(root, "state/state.db", require_file=True)
        identity = db_path.stat().st_dev, db_path.stat().st_ino
        with closing(sqlite3.connect(db_path.as_uri()+"?mode=rw", uri=True, timeout=0)) as db:
            db.execute("PRAGMA trusted_schema=OFF")
            db.execute("PRAGMA synchronous=FULL")
            if (db.execute("PRAGMA application_id").fetchone()[0] != view.APP_ID or
                    db.execute("PRAGMA user_version").fetchone()[0] != view.SCHEMA_VERSION):
                raise CommentError("invalid_database", "기존 상태 DB를 확인해야 합니다.")
            with db:
                db.execute("BEGIN IMMEDIATE")
                meta = {key: json.loads(value) for key, value in db.execute("SELECT key,value FROM meta WHERE key IN ('root','library_id')")}
                if meta != {"root": str(root), "library_id": library}:
                    raise CommentError("library_mismatch", "기존 DB와 미디어 폴더의 연결이 바뀌었습니다.")
                deleted, _ = database_deletions(root, db)
                if (post["account"], post["postId"]) in deleted:
                    raise CommentError("post_missing", "삭제된 게시글에는 댓글 정보를 저장할 수 없습니다.")
                # Recheck registration inside the write transaction; source media
                # availability is independent of a registered post's text comment.
                try:
                    draft = view.read_drafts(root, excluded_posts=deleted, db=db).get((post["account"], post["postId"]))
                except (ValueError, sqlite3.Error, TypeError) as exc:
                    raise CommentError("drafts_unavailable", "등록 게시글을 확인하지 못했습니다. 새로고침한 뒤 댓글을 저장하세요.") from exc
                if draft is None:
                    raise CommentError("comment_draft_missing", "게시글을 등록한 뒤 댓글 정보를 저장하세요.")
                cancelled(check)
                comment = {"caption": caption, "link": link, "updatedAt": datetime.now(timezone.utc).isoformat()}
                write_comment(db, post, comment)
                safe_path(root, "state/state.db", require_file=True)
                current = db_path.stat()
                if identity != (current.st_dev, current.st_ino):
                    raise CommentError("state_changed", "저장하는 동안 DB 파일이 변경되었습니다.")
                require_no_pending(root)
                lock.assert_owned()
                cancelled(check)
        return {"ok": True, "postKey": data["postKey"], "comment": comment}


def main():
    stopped = False
    monitor = None
    def stop(*_):
        nonlocal stopped
        stopped = True
    for sig in (signal.SIGTERM, signal.SIGINT): signal.signal(sig, stop)
    try:
        monitor = ParentMonitor()
        raw = sys.stdin.buffer.read(INPUT_LIMIT+1)
        if not raw or len(raw) > INPUT_LIMIT:
            raise CommentError("invalid_request", "댓글 정보 저장 요청의 크기나 형식을 확인하세요.")
        result = execute(parse_json(raw), check=lambda: stopped or monitor.cancelled())
    except (CommentError, SourceError, view.InputError, StateError, MonitorError) as exc:
        result = {"ok": False, "error": {"code": exc.code, "message": str(exc)}}
    except Exception:
        result = {"ok": False, "error": {"code": "comment_save_failed", "message": "댓글 정보를 저장하지 못했습니다. 기존 자료는 보존했습니다."}}
    finally:
        if monitor is not None: monitor.close()
    print(json.dumps(result, ensure_ascii=False, allow_nan=False), flush=True)
    return 0 if result["ok"] else 1


if __name__ == "__main__": sys.exit(main())
