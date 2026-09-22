"""Read-only deletion visibility shared by local views and download workers."""
from contextlib import closing
import hashlib
import json
from pathlib import Path
import re
import sqlite3

from . import excel_input
from .state import APP_ID, SCHEMA_VERSION, StateError, safe_path


def deletion_pending(root):
    work = safe_path(Path(root), "_work")
    if not work.exists():
        return False
    return any(re.fullmatch(r"delete-[0-9a-f]{32}", item.name) and
               ((item / "journal.json").exists() or (item / "journal.json").is_symlink())
               for item in work.iterdir())


def require_no_pending(root):
    if deletion_pending(root) or abandoned_deletion(root):
        raise StateError("deletion_recovery_required", "완료되지 않은 삭제 작업이 있습니다. 삭제 작업 복구를 먼저 실행하세요.")


def abandoned_deletion(root):
    path = safe_path(Path(root), "_work/collector.lock")
    if not path.exists():
        return False
    try:
        safe_path(Path(root), "_work/collector.lock", require_file=True)
        with path.open('rb') as stream:
            raw = stream.read(4097)
        if len(raw) > 4096:
            return False
        value = json.loads(raw)
        if (not isinstance(value, dict) or value.get('owner') != 'media-delete' or
                not re.fullmatch(r'[a-f0-9]{32}', str(value.get('token', '')))):
            return False
        from .recovery import definitely_dead
        return definitely_dead(value.get('pid'))
    except (OSError, ValueError):
        return False


def _database_rows(db):
    tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    posts, edits = set(), set()
    if "post_deletions" in tables:
        for account, post_id, deleted_at in db.execute("SELECT account,post_id,deleted_at FROM post_deletions"):
            if not all(isinstance(value, str) and value for value in (account, post_id, deleted_at)):
                raise StateError("invalid_database", "게시글 삭제 기록을 확인해야 합니다.")
            posts.add((account, post_id))
    if "edit_deletions" in tables:
        for edit_id, deleted_at in db.execute("SELECT edit_id,deleted_at FROM edit_deletions"):
            if not isinstance(edit_id, str) or not re.fullmatch(r"[0-9a-f]{32}", edit_id) or not isinstance(deleted_at, str) or not deleted_at:
                raise StateError("invalid_database", "편집본 삭제 기록을 확인해야 합니다.")
            edits.add(edit_id)
    return posts, edits


def database_deletions(root, db=None):
    if db is not None:
        return _database_rows(db)
    root = Path(root)
    path = safe_path(root, "state/state.db")
    if not path.exists():
        return set(), set()
    safe_path(root, "state/state.db", require_file=True)
    for suffix in ("-wal", "-journal"):
        pending = safe_path(root, "state/state.db" + suffix)
        if pending.exists() and pending.stat().st_size:
            raise StateError("state_busy", "미확정 DB 기록이 있습니다. 실행기를 정상 종료한 뒤 새로고침하세요.")
    with closing(sqlite3.connect(path.as_uri() + "?mode=ro&immutable=1", uri=True, timeout=0)) as connection:
        connection.execute("PRAGMA query_only=ON")
        connection.execute("PRAGMA trusted_schema=OFF")
        if (connection.execute("PRAGMA application_id").fetchone()[0] != APP_ID or
                connection.execute("PRAGMA user_version").fetchone()[0] != SCHEMA_VERSION):
            raise StateError("invalid_database", "지원하지 않는 상태 DB입니다.")
        saved_root = connection.execute("SELECT value FROM meta WHERE key='root'").fetchone()
        if not saved_root or json.loads(saved_root[0]) != str(root):
            raise StateError("root_changed", "기존 라이브러리의 폴더 연결을 확인해야 합니다.")
        return _database_rows(connection)


def _workbook_deletions(root, source):
    deleted = set()
    path = safe_path(root, source["relative_path"], require_file=True)
    raw = excel_input._read_stable(path)
    digest = hashlib.sha256(raw).hexdigest()
    if source.get("sha256", digest) != digest:
        raise StateError("source_changed", "삭제 정보를 읽는 중 원본이 변경되었습니다.")
    book = excel_input._Workbook(raw)
    try:
        named = {cell["value"] for cell in book.rows("게시글").get(6, {}).values()}
        if "삭제여부" in named:
            # The timestamp is informational; a damaged/empty date must not resurrect a Y-marked post.
            columns = ("계정명", "게시글ID", "삭제여부", *(
                name for name in ("삭제시각(KST)", "삭제일(KST)") if name in named))
            result = {"errors": [], "warnings": []}
            rows = excel_input._table(book, "게시글", columns, result)
            if result["errors"]:
                raise StateError("invalid_deletion", "Excel 삭제 표식을 확인해야 합니다.")
            for row in rows:
                if str(row.get("삭제여부", "")).strip().upper() == "Y":
                    key = row.get("계정명"), row.get("게시글ID")
                    if not all(isinstance(value, str) and value for value in key):
                        raise StateError("invalid_deletion", "Excel 삭제 표식의 게시글 연결을 확인해야 합니다.")
                    deleted.add(key)
    finally:
        book.archive.close()
    if hashlib.sha256(excel_input._read_stable(path)).hexdigest() != digest:
        raise StateError("source_changed", "삭제 정보를 읽는 중 원본이 변경되었습니다.")
    return deleted


def excel_deletions(root, sources=None):
    """Union all explicit Y marks, including older observations and DB-free roots."""
    root = Path(root)
    discovered = sources is None
    sources = sources if sources is not None else [
        {"relative_path": path.relative_to(root).as_posix()} for path in excel_input.discover_workbooks(root)]
    deleted = set()
    for source in sources:
        try:
            deleted |= _workbook_deletions(root, source)
        except excel_input.InputError as exc:
            if discovered:
                # The source reader still blocks malformed workbooks before any transfer.
                # Historical status/local recovery remain inspectable even if a workbook broke.
                continue
            raise StateError(exc.code, str(exc)) from exc
    return deleted


def deleted_posts(root, *, db=None, sources=None):
    posts, _ = database_deletions(root, db)
    return posts | excel_deletions(root, sources)


def filter_source(data, deleted):
    return {**data, "posts": [post for post in data["posts"] if (post["계정명"], post["게시글ID"]) not in deleted],
            "media": [item for item in data["media"] if (item["계정명"], item["게시글ID"]) not in deleted]}


def load_source(root, *, db=None):
    data = excel_input.load_collection(root)
    return filter_source(data, deleted_posts(root, db=db, sources=data["sources"]))


def active_jobs(state, statuses=None, *, deleted=None):
    deleted = deleted if deleted is not None else deleted_posts(state.root, db=state.db)
    return [row for row in state.db.execute("SELECT j.*,m.account,m.post_id,m.ordinal,m.kind FROM jobs j JOIN media m USING(media_id)")
            if (row["account"], row["post_id"]) not in deleted and (statuses is None or row["status"] in statuses)]
