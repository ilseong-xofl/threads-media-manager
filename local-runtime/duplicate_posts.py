"""Remove newly downloaded posts whose first saved media matches an older post.

The comparison uses the SHA-256 already recorded during download. Only a
matching pair is re-read from disk; the existing deletion journal performs the
actual whole-post removal and Excel/SQLite updates.
"""
from collections import defaultdict
from contextlib import closing
import hashlib
import json
from pathlib import Path

import delete_media as deletion
from threads_runner import attempts, deletion_state
from threads_runner.state import safe_path


def _saved_posts(db, source, deleted):
    expected = defaultdict(list)
    collected = {}
    for post in source["posts"]:
        key = post["계정명"], post["게시글ID"]
        collected[key] = post["수집일(KST)"]
    for item in source["media"]:
        expected[item["계정명"], item["게시글ID"]].append((item["순서"], item["종류"]))

    media = defaultdict(dict)
    completed = {}
    retired = attempts.retired_ids(db)
    for row in db.execute("""SELECT m.account,m.post_id,m.ordinal,m.kind,m.media_id,
            j.job_id,j.status,j.final_rel,j.size,j.sha256,j.updated_at
            FROM media m LEFT JOIN jobs j USING(media_id)"""):
        key = row["account"], row["post_id"]
        if key in deleted:
            continue
        media[key][row["ordinal"]] = row["kind"]
        if row["job_id"] in retired or row["status"] != "complete":
            continue
        attachment = key + (row["ordinal"],)
        previous = completed.get(attachment)
        if previous is None or (row["updated_at"], row["job_id"]) > (previous["updated_at"], previous["job_id"]):
            completed[attachment] = row

    result = {}
    for key, actual in media.items():
        wanted = expected.get(key)
        # A source-less saved post can still be an existing comparison target.
        wanted = wanted if wanted is not None else list(actual.items())
        if not wanted or dict(wanted) != actual:
            continue
        first = {}
        for ordinal, kind in sorted(wanted):
            row = completed.get(key + (ordinal,))
            if row is None or row["kind"] != kind:
                break
            if kind not in first:
                match = deletion.view.FILE.fullmatch(row["final_rel"] or "")
                if (not isinstance(row["sha256"], str) or not deletion.HEX.fullmatch(row["sha256"]) or
                        type(row["size"]) is not int or row["size"] < 1 or not match or
                        match[1] != row["media_id"] or
                        (kind == "image") != (match[2] in {"jpg", "jpeg", "png", "webp", "gif"})):
                    break
                first[kind] = row
        else:
            result[key] = {"collectedAt": collected.get(key, ""), "first": first}
    return result


def _protected(root, db, key):
    for table in ("post_drafts", "post_comments", "media_edits"):
        if deletion.has_table(db, table) and db.execute(
                f"SELECT 1 FROM {table} WHERE account=? AND post_id=? LIMIT 1", key).fetchone():
            return True
    post_key = json.dumps(key, ensure_ascii=False, separators=(",", ":"))
    folder = safe_path(root, "ai-drafts/" + hashlib.sha256(post_key.encode()).hexdigest()[:32])
    return folder.exists() and any(folder.iterdir())


def _auto_plan(root, key, lock):
    """Targeted plan: hash this post's files, without hashing the whole library."""
    deletion.require_no_pending(root)
    with closing(deletion.open_db(root)) as db:
        if _protected(root, db, key):
            raise deletion.DeleteError("duplicate_protected", "중복 게시글에 등록·편집 작업이 있어 자동 삭제하지 않았습니다.")
        retired = attempts.retired_ids(db)
        if any(row[0] not in retired for row in db.execute(
                "SELECT job_id FROM jobs WHERE status IN ('planned','running','staged')")):
            raise deletion.DeleteError("pending_download_plan", "미완료 다운로드 계획이 있어 중복 삭제하지 않았습니다.")
        rows = [dict(row) for row in db.execute("""SELECT j.*,m.kind FROM jobs j
            JOIN media m USING(media_id) WHERE m.account=? AND m.post_id=? ORDER BY j.job_id""", key)]
        if not rows or not any(row["status"] == "complete" for row in rows):
            raise deletion.DeleteError("deletion_changed", "중복 게시글의 저장 상태가 변경되었습니다.")
        library = json.loads(db.execute("SELECT value FROM meta WHERE key='library_id'").fetchone()[0])
    files = {}
    for row in rows:
        if row["final_rel"]:
            match = deletion.view.FILE.fullmatch(row["final_rel"])
            if (not match or match[1] != row["media_id"] or type(row["size"]) is not int or
                    not deletion.HEX.fullmatch(row["sha256"] or "")):
                raise deletion.DeleteError("invalid_local_path", "중복 게시글의 파일 연결을 확인해야 합니다.")
            record = deletion.file_record(root, row["final_rel"], row["size"], row["sha256"])
            if row["status"] == "complete" and not record["exists"]:
                raise deletion.DeleteError("deletion_changed", "중복 게시글의 저장 파일이 없어 자동 삭제하지 않았습니다.")
            files[row["final_rel"]] = record
        if row["part_rel"]:
            if row["part_rel"] != f"media/.partial/{row['job_id']}.part" or not deletion.view.UUID.fullmatch(row["job_id"]):
                raise deletion.DeleteError("invalid_local_path", "중복 게시글의 부분 파일 연결을 확인해야 합니다.")
            files[row["part_rel"]] = deletion.file_record(root, row["part_rel"])
    books = deletion.workbook_targets(root, *key)
    if not books:
        raise deletion.DeleteError("post_missing", "중복 게시글의 수집 Excel 행을 찾지 못했습니다.")
    current = {"kind": "post", "postKey": json.dumps(key, ensure_ascii=False, separators=(",", ":")),
        "account": key[0], "postId": key[1], "mediaId": None, "libraryId": library, "draft": None,
        "files": sorted(files.values(), key=lambda item: item["path"]), "books": books,
        "edits": [], "jobs": rows}
    current["fingerprint"] = deletion.digest(deletion.encoded(current))
    lock.assert_owned()
    return current


def remove_new_duplicates(root, completed_keys, *, check=lambda: False, progress=lambda processed, removed: None):
    """Return how many newly completed whole posts were safely removed."""
    root = Path(root)
    keys = [tuple(key) for key in completed_keys]
    if not keys:
        return 0
    with deletion.DeleteLock(root) as lock:
        deletion.require_no_pending(root)
        with closing(deletion.open_db(root)) as db:
            source = deletion_state.load_source(root, db=db)
            if source["errors"]:
                raise deletion.DeleteError("invalid_source", "수집 Excel 원본을 확인해야 중복을 삭제할 수 있습니다.")
            deleted = deletion_state.deleted_posts(root, db=db, sources=source["sources"])
            saved = _saved_posts(db, source, deleted)
        if any(key not in saved or not saved[key]["collectedAt"] for key in keys):
            raise deletion.DeleteError("deletion_changed", "새로 저장한 게시글의 원본 또는 파일 상태가 변경되었습니다.")
        keepers = defaultdict(list)
        new = set(keys)
        for key, post in saved.items():
            if key not in new:
                for kind, item in post["first"].items():
                    keepers[kind, item["sha256"]].append(item)
        removed = 0
        for index, key in enumerate(sorted(new, key=lambda item: (saved[item]["collectedAt"], item)), 1):
            deletion.stopped(check)
            post = saved[key]
            match = next(((item, existing) for kind, item in post["first"].items()
                          for existing in keepers[kind, item["sha256"]]), None)
            if match:
                item, existing = match
                # Stored digests make the scan cheap. Re-read only the matching
                # first files so stale or changed files cannot cause deletion.
                old_file = deletion.file_record(root, existing["final_rel"], existing["size"], existing["sha256"])
                new_file = deletion.file_record(root, item["final_rel"], item["size"], item["sha256"])
                if not old_file["exists"] or not new_file["exists"]:
                    raise deletion.DeleteError("deletion_changed", "중복 비교 파일이 없어 자동 삭제하지 않았습니다.")
                current = _auto_plan(root, key, lock)
                deletion.commit_current(root, current, lock, check)
                removed += 1
            else:
                for kind, item in post["first"].items():
                    keepers[kind, item["sha256"]].append(item)
            progress(index, removed)
        return removed
