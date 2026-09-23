"""Read-only Electron view. No downloader, migrations, locks, or network calls.

Reuse the collector's versioned source reader. Existing pilot state is opened
immutable only after ruling out a pending WAL/journal; a live WAL is reported,
never checkpointed or silently ignored. All source/CDN URLs stay out of media
registrations and renderer attachment data.
"""
from __future__ import annotations

import argparse
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import sys
from urllib.parse import unquote, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "plugins/threads-collector/scripts"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from threads_source import excel_input
from threads_source.files import SourceError, collection_root, read_stable, safe_path, parse_json, CollectionLock
from threads_source.excel_input import InputError
from threads_runner.state import APP_ID, SCHEMA_VERSION, StateError
from threads_runner import attempts, deletion_state, source_readiness
import ai_media

UUID = re.compile(r"[0-9a-f]{32}")
FILE = re.compile(r"media/files/[0-9a-f]{32}/([0-9a-f]{32})\.(jpg|jpeg|png|webp|gif|mp4|webm|mov)")
EDIT_FORMAT = {"crop": ("image", "png"), "capture": ("image", "png"), "trim": ("video", "mp4")}


def idle(root, owned_lock=None):
    if owned_lock is not None:
        if (not isinstance(owned_lock, CollectionLock) or not owned_lock.owns_lock or
                owned_lock.borrowed_token is not None or owned_lock.root != root):
            raise SourceError("busy", "편집 작업의 잠금 소유권을 확인할 수 없습니다.")
        owned_lock.assert_owned()
        return
    lock = safe_path(root, "_work/collector.lock")
    if lock.exists():
        if deletion_state.abandoned_deletion(root):
            raise SourceError("deletion_recovery_required", "완료되지 않은 삭제 작업이 있습니다. 삭제 작업 복구를 실행하세요.")
        raise SourceError("busy", "수집 또는 다운로드가 진행 중입니다. 종료 후 새로고침하세요.")


def stamp(path):
    info = path.stat()
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns


def state_signature(root):
    result = {}
    for rel in ("state/state.db", "state/state.db-wal", "state/state.db-shm", "state/state.db-journal", "media/.library.json"):
        path = safe_path(root, rel)
        result[rel] = stamp(path) if path.exists() else None
        if path.exists():
            safe_path(root, rel, require_file=True)
        if rel.endswith(("-wal", "-journal")) and path.exists() and path.stat().st_size:
            raise SourceError("state_busy", "미확정 DB 기록이 있습니다. 실행기를 정상 종료한 뒤 새로고침하세요.")
    return result


def local_file(root, row, *, include_ai=False):
    if include_ai and isinstance(row["final_rel"], str) and row["final_rel"].startswith("ai-drafts/"):
        if row["kind"] != "image":
            raise SourceError("invalid_ai_media", "AI 생성 이미지의 종류를 확인하세요.")
        record = ai_media.file_record(root, row["final_rel"], row["media_id"], row["sha256"])
        if record["size"] != row["size"]:
            raise SourceError("ai_media_changed", "AI 생성 이미지의 크기가 변경되었습니다.")
        return record
    relative = row["final_rel"]
    match = FILE.fullmatch(relative or "")
    if not match or match[1] != row["media_id"]:
        raise SourceError("invalid_local_path", "저장 파일의 연결 경로를 확인해야 합니다.")
    if (row["kind"] == "image") != (match[2] in {"jpg", "jpeg", "png", "webp", "gif"}):
        raise SourceError("media_kind_conflict", "저장 파일의 종류가 원본 연결과 다릅니다.")
    path = safe_path(root, relative, require_file=True)
    before = stamp(path)
    if before[2] != row["size"] or not before[2]:
        raise SourceError("local_file_changed", "저장 파일의 크기가 달라졌습니다. 파일을 보존했습니다.")
    digest = hashlib.sha256()
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
    with os.fdopen(os.open(path, flags), "rb") as stream:
        opened = os.fstat(stream.fileno())
        if (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns, opened.st_ctime_ns) != before:
            raise SourceError("local_file_changed", "읽는 중 저장 파일이 변경되었습니다.")
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    safe_path(root, relative, require_file=True)
    if stamp(path) != before or digest.hexdigest() != row["sha256"]:
        raise SourceError("local_file_changed", "저장 파일의 해시가 다릅니다. 파일을 보존했습니다.")
    return {"id": row["media_id"], "relativePath": relative, "size": row["size"],
            "sha256": row["sha256"], "kind": row["kind"]}


def read_state(root, excluded_posts=None):
    signature = state_signature(root)
    if signature["state/state.db"] is None:
        media = safe_path(root, "media")
        if media.exists() and any(media.iterdir()):
            raise SourceError("state_missing", "기존 파일의 상태 DB 연결이 필요합니다. 초기화하지 않았습니다.")
        return {}, [], "absent", signature
    db_path = safe_path(root, "state/state.db", require_file=True)
    marker = parse_json(read_stable(safe_path(root, "media/.library.json", require_file=True), max_bytes=4096))
    with closing(sqlite3.connect(db_path.as_uri() + "?mode=ro&immutable=1", uri=True, timeout=0)) as db:
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA query_only=ON")
        db.execute("PRAGMA trusted_schema=OFF")
        if (db.execute("PRAGMA application_id").fetchone()[0] != APP_ID or
                db.execute("PRAGMA user_version").fetchone()[0] != SCHEMA_VERSION or
                db.execute("PRAGMA quick_check").fetchone()[0] != "ok"):
            raise SourceError("invalid_database", "지원하지 않거나 손상된 상태 DB입니다. 기존 DB를 보존했습니다.")
        meta = {row[0]: json.loads(row[1]) for row in db.execute("SELECT key,value FROM meta WHERE key IN ('library_id','root')")}
        if not isinstance(marker, dict) or marker.get("schema_version") != 1 or marker.get("library_id") != meta.get("library_id"):
            raise SourceError("library_mismatch", "저장된 DB와 미디어 폴더의 연결이 다릅니다.")
        if not UUID.fullmatch(meta.get("library_id", "")) or meta.get("root") != str(root):
            raise SourceError("root_changed", "기존 라이브러리의 폴더 연결을 확인해야 합니다.")
        retired = attempts.retired_ids(db)
        rows = db.execute("""SELECT m.*, j.job_id,j.status,j.final_rel,j.size,j.sha256,j.error_code
            FROM media m LEFT JOIN jobs j ON j.media_id=m.media_id
            ORDER BY (j.status='complete') DESC, j.updated_at DESC, j.job_id DESC""").fetchall()
        deleted, _ = deletion_state.database_deletions(root, db)
        deleted |= set(excluded_posts or ())
    links, files = {}, []
    for row in rows:
        if row["job_id"] in retired:
            continue
        key = row["account"], row["post_id"], row["ordinal"]
        if key[:2] in deleted:
            continue
        if key in links:
            continue
        if not UUID.fullmatch(row["media_id"]) or row["kind"] not in {"image", "video"} or type(row["ordinal"]) is not int or row["ordinal"] < 1:
            raise SourceError("invalid_database", "상태 DB의 첨부 연결을 확인해야 합니다.")
        value = {"mediaId": row["media_id"], "kind": row["kind"], "status": "review",
                 "reason": row["error_code"] or row["status"] or "pending", "localUrl": None}
        if row["status"] == "complete":
            try:
                item = local_file(root, row)
                files.append(item)
                value.update(status="saved", reason=None, localUrl=f"threads-media://file/{row['media_id']}")
            except (SourceError, OSError) as exc:
                value["reason"] = exc.code if isinstance(exc, SourceError) else "local_file_unavailable"
        links[key] = value
    if state_signature(root) != signature:
        raise SourceError("state_changed", "읽는 중 상태 DB가 변경되었습니다. 다시 새로고침하세요.")
    return links, files, "read_only", signature


def read_edits(root, links, excluded_posts=None):
    """Optional edit records never change original attachment/download status."""
    mapping, files, warnings = {}, [], []
    path = safe_path(root, "state/state.db", require_file=True)
    marker = parse_json(read_stable(safe_path(root, "media/.library.json", require_file=True), max_bytes=4096))
    known = {value["mediaId"]: (key[0], key[1], value["kind"]) for key, value in links.items()}
    with closing(sqlite3.connect(path.as_uri() + "?mode=ro&immutable=1", uri=True, timeout=0)) as db:
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA query_only=ON")
        db.execute("PRAGMA trusted_schema=OFF")
        if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='media_edits'").fetchone():
            return mapping, files, warnings
        rows = db.execute("SELECT * FROM media_edits ORDER BY sequence, edit_id").fetchall()
        deleted_posts, deleted_edits = deletion_state.database_deletions(root, db)
        deleted_posts |= set(excluded_posts or ())
    for row in rows:
        value = dict(row)
        try:
            key = value["account"], value["post_id"]
            if key in deleted_posts:
                continue
            date = datetime.fromisoformat(value["created_at"])
            if (not UUID.fullmatch(value["edit_id"]) or not UUID.fullmatch(value["source_media_id"]) or
                    value["edit_type"] not in EDIT_FORMAT or date.tzinfo is None or
                    type(value["sequence"]) is not int or value["sequence"] < 1 or
                    not all(isinstance(part, str) and part for part in key)):
                raise ValueError()
            if value['edit_type'] == 'trim' and (
                    any(type(value.get(field)) not in (int, float) or not math.isfinite(value[field]) for field in ('trim_start', 'trim_end')) or
                    not 0 <= value['trim_start'] < value['trim_end']):
                raise ValueError()
        except (KeyError, TypeError, ValueError):
            warnings.append({"code": "invalid_edit", "message": "편집 결과의 연결 정보를 확인해야 합니다. 원본 첨부는 유지했습니다."})
            continue
        kind, extension = EDIT_FORMAT[value['edit_type']]
        item = {"kind": kind, "status": "review", "reason": "edit_source_missing", "localUrl": None,
                "mediaId": value["edit_id"], "editType": value["edit_type"], "sourceMediaId": value["source_media_id"],
                "createdAt": value["created_at"], "addressStatus": "missing", "observedAt": value["created_at"]}
        try:
            expected_kind = "image" if value["edit_type"] == "crop" else "video"
            if known.get(value["source_media_id"]) != (*key, expected_kind) or value["edit_id"] in known:
                raise SourceError("edit_source_missing", "편집 결과의 원본 연결을 확인해야 합니다.")
            if value["final_rel"] != f"media/files/{marker['library_id']}/{value['edit_id']}.{extension}":
                raise SourceError("invalid_edit", "편집 결과의 저장 경로를 확인해야 합니다.")
            if value["edit_id"] in deleted_edits:
                # Deleted intermediate media remain valid ancestry for saved descendants.
                known[value["edit_id"]] = (*key, kind)
                continue
            registered = local_file(root, {**value, "media_id": value["edit_id"], "kind": kind})
            if not registered["relativePath"].endswith('.' + extension):
                raise SourceError("invalid_edit", "편집 결과의 저장 형식을 확인해야 합니다.")
            files.append(registered)
            item.update(status="saved", reason=None, localUrl=f"threads-media://file/{value['edit_id']}")
        except (SourceError, OSError, KeyError, TypeError) as exc:
            item["reason"] = exc.code if isinstance(exc, SourceError) else "local_file_unavailable"
        known[value["edit_id"]] = (*key, kind)
        if value["edit_id"] not in deleted_edits:
            mapping.setdefault(key, []).append(item)
    return mapping, files, warnings


def validate_comment_link(link):
    """Match the local HTTP(S) link boundary when reading and writing drafts."""
    if not link:
        return
    parsed = urlsplit(link)
    if (not re.match(r"^https?://", link, re.IGNORECASE) or not parsed.hostname or
            parsed.username is not None or parsed.password is not None or "@" in parsed.netloc or
            any(char.isspace() or ord(char) < 32 or ord(char) == 127 or char == "\\" for char in link)):
        raise ValueError("Invalid stored comment link")
    parsed.port  # Evaluate malformed and out-of-range ports before adopting the link.
    if re.search(r"%(?![0-9a-fA-F]{2})", parsed.hostname):
        raise ValueError("Invalid stored comment hostname")
    hostname = unquote(parsed.hostname, errors="strict")
    if (any(char.isspace() or ord(char) < 32 or ord(char) == 127 or char in "%/\\#?@[]<>^|" for char in hostname) or
            (":" in hostname and not parsed.netloc.startswith("["))):
        raise ValueError("Invalid stored comment hostname")
    hostname.encode("idna")


def read_comments(root, excluded_posts=None):
    """Optional local drafts are read without creating or repairing storage."""
    path = safe_path(root, "state/state.db", require_file=True)
    with closing(sqlite3.connect(path.as_uri() + "?mode=ro&immutable=1", uri=True, timeout=0)) as db:
        db.execute("PRAGMA query_only=ON")
        db.execute("PRAGMA trusted_schema=OFF")
        table = db.execute("SELECT type FROM sqlite_master WHERE name='post_comments'").fetchone()
        if not table:
            return {}
        if table[0] != "table":
            raise ValueError("Invalid stored comment table")
        rows = db.execute("SELECT account,post_id,caption,link,updated_at FROM post_comments").fetchall()
    result = {}
    for account, post_id, caption, link, updated_at in rows:
        if not all(isinstance(value, str) for value in (account, post_id, caption, link, updated_at)):
            raise ValueError("Invalid stored comment")
        key = account, post_id
        if key in (excluded_posts or ()):
            continue
        if (not account or not post_id or key in result or len(caption.encode("utf-16-le")) // 2 > 10000 or len(link.encode("utf-16-le")) // 2 > 2048 or
                caption != caption.strip() or link != link.strip() or not (caption or link) or
                any(ord(char) < 32 and char not in "\n\r\t" for char in caption) or "\x7f" in caption):
            raise ValueError("Invalid stored comment")
        validate_comment_link(link)
        date = datetime.fromisoformat(updated_at)
        if (len(updated_at) > 64 or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)", updated_at) or
                date.tzinfo is None or date.utcoffset().total_seconds() != 0):
            raise ValueError("Invalid stored comment timestamp")
        result[key] = {"caption": caption, "link": link, "updatedAt": updated_at}
    return result


POST_DRAFT_COLUMNS = ("account", "post_id", "caption", "media_ids_json", "created_at", "updated_at", "revision")
MAX_DRAFT_REVISION = 9_007_199_254_740_991


def draft_schema(db):
    table = db.execute("SELECT type FROM sqlite_master WHERE name='post_drafts'").fetchone()
    if not table: return False
    if table[0] != "table": raise ValueError("Invalid draft table")
    columns = db.execute("PRAGMA table_info(post_drafts)").fetchall()
    if (tuple(row[1] for row in columns) != POST_DRAFT_COLUMNS or
            tuple(row[2].upper() for row in columns) != ("TEXT",)*6+("INTEGER",) or
            tuple(row[5] for row in columns) != (1, 2, 0, 0, 0, 0, 0) or
            db.execute("SELECT 1 FROM sqlite_master WHERE type='trigger' AND tbl_name='post_drafts'").fetchone()):
        raise ValueError("Invalid draft schema")
    return True


def draft_caption(value):
    if (not isinstance(value, str) or len(value.encode("utf-16-le"))//2 > 10000 or
            any(ord(char) < 32 and char not in "\t\n\r" for char in value) or "\x7f" in value):
        raise ValueError("Invalid draft caption")
    return value


def draft_media_ids(value):
    if (not isinstance(value, list) or not 1 <= len(value) <= 100 or
            any(not isinstance(item, str) or not UUID.fullmatch(item) for item in value) or len(set(value)) != len(value)):
        raise ValueError("Invalid draft media selection")
    return value


def _read_drafts(db, excluded_posts=None):
    if not draft_schema(db): return {}
    result = {}
    for account, post_id, caption, raw_ids, created, updated, revision in db.execute(
            "SELECT account,post_id,caption,media_ids_json,created_at,updated_at,revision FROM post_drafts"):
        if not isinstance(account, str) or not account or not isinstance(post_id, str) or not post_id:
            raise ValueError("Invalid draft identity")
        key = account, post_id
        if key in (excluded_posts or ()): continue
        if key in result or not isinstance(raw_ids, str) or len(raw_ids) > 16384:
            raise ValueError("Invalid draft selection record")
        draft_caption(caption)
        media_ids = draft_media_ids(json.loads(raw_ids))
        dates = []
        for value in (created, updated):
            if (not isinstance(value, str) or len(value) > 64 or
                    not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)", value)):
                raise ValueError("Invalid draft date")
            date = datetime.fromisoformat(value)
            if date.tzinfo is None or date.utcoffset().total_seconds() != 0:
                raise ValueError("Invalid draft timezone")
            dates.append(date)
        if dates[1] < dates[0] or type(revision) is not int or not 1 <= revision <= MAX_DRAFT_REVISION:
            raise ValueError("Invalid draft revision")
        result[key] = {"caption": caption, "mediaIds": media_ids, "createdAt": created, "updatedAt": updated, "revision": revision}
    return result


def read_drafts(root, excluded_posts=None, *, db=None):
    """Keep selected IDs even when files are missing, so a saved draft remains editable."""
    if db is not None: return _read_drafts(db, excluded_posts)
    path = safe_path(root, "state/state.db", require_file=True)
    with closing(sqlite3.connect(path.as_uri()+"?mode=ro&immutable=1", uri=True, timeout=0)) as connection:
        connection.execute("PRAGMA query_only=ON")
        connection.execute("PRAGMA trusted_schema=OFF")
        return _read_drafts(connection, excluded_posts)


def read_snapshot(path, *, owned_lock=None, include_ai=False):
    root = collection_root(Path(path))
    idle(root, owned_lock)
    try:
        source = source_readiness.normalize(root, excel_input.load_collection(root))
    except (StateError, source_readiness.excel_input.InputError) as exc:
        raise SourceError(exc.code, str(exc)) from exc
    excluded_posts = deletion_state.excel_deletions(root, source["sources"])
    observations = {}
    for item in source["sources"]:
        current = excel_input.read_workbook(safe_path(root, item["relative_path"], require_file=True))
        if current["source_sha256"] != item["sha256"]:
            raise SourceError("source_changed", "읽는 중 원본이 변경되었습니다.")
        for post in current["posts"]:
            observations.setdefault((post["계정명"], post["게시글ID"]), []).append(post)
    # Historical scan interruptions/gaps do not require action on saved posts.
    # Keep their source/run metadata, but do not show permanent global alerts.
    warnings = [{"code": item["code"], "message": "수집 기록의 주의 사항이 있습니다: " + item["code"]}
                for item in source["warnings"] if item["code"] not in {"partial_collection", "possible_gap"}]
    if deletion_state.deletion_pending(root):
        warnings.append({"code": "deletion_recovery_required", "message": "완료되지 않은 삭제 작업이 있습니다. 삭제 작업 복구를 실행하세요."})
    state_stamp = None
    try:
        links, files, state_status, state_stamp = read_state(root, excluded_posts)
        excluded_posts |= deletion_state.database_deletions(root)[0]
    except (SourceError, StateError, sqlite3.Error, ValueError, OSError, TypeError) as exc:
        links, files, state_status = {}, [], "unavailable"
        warnings.append({"code": exc.code if isinstance(exc, (SourceError, StateError)) else "state_unavailable",
                         "message": str(exc) if isinstance(exc, (SourceError, StateError)) else "기존 저장 상태를 읽을 수 없습니다. DB와 파일을 보존했습니다."})
    source = deletion_state.filter_source(source, excluded_posts)
    # Only errors owned by tombstoned source posts can be removed. Preserve the
    # existing unavailable-state view for a damaged DB or stored media file.
    if source["errors"]:
        first = source["errors"][0]
        raise SourceError(first["code"], "원본 기록의 연결 또는 관찰 값이 충돌합니다. 마지막 정상 목록을 유지합니다.")
    attachments = {}
    for row in source["media"]:
        key = row["계정명"], row["게시글ID"], row["순서"]
        status = {"status": "unavailable" if state_status == "unavailable" else "not_downloaded", "reason": None, "mediaId": None, "localUrl": None}
        status.update({k: v for k, v in links.get(key, {}).items() if k != "kind"})
        if key in links and links[key]["kind"] != row["종류"]:
            status.update(status="review", reason="media_kind_conflict", localUrl=None)
        attachments.setdefault(key[:2], []).append({"ordinal": key[2], "kind": row["종류"],
            "addressStatus": row["주소상태"], "observedAt": row["URL확보시각(KST)"], **status})
    runs = {(row["계정명"], row["실행ID"]): row for row in source["runs"]}
    posts = []
    for row in source["posts"]:
        key = row["계정명"], row["게시글ID"]
        run = runs.get((key[0], row["확인실행ID"]), {})
        samples = observations[key]
        caption = max(samples, key=lambda p: ({"complete": 2, "partial": 1, "unknown": 0}.get(p["캡션 상태"], -1), datetime.fromisoformat(p.get("_caption_time") or p["최근확인시각(KST)"])))
        latest = max(samples, key=lambda p: datetime.fromisoformat(p["최근확인시각(KST)"]))
        dates = {datetime.fromisoformat(p["등록일(KST)"]) for p in samples if p.get("등록일(KST)")}
        reasons = list(row.get("_reasons", []))
        if len(dates) > 1:
            reasons.append("published_date_conflict")
        if (caption.get("_caption_run") or caption["확인실행ID"]) != row["확인실행ID"]:
            reasons.append("earlier_caption")
        if row.get("_attachment_source"):
            reasons.append("earlier_attachments")
        posts.append({"key": json.dumps(key, ensure_ascii=False, separators=(",", ":")),
            "account": key[0], "postId": key[1], "originalUrl": row["원문URL"],
            "publishedAt": next(iter(dates)).isoformat() if len(dates) == 1 else None,
            "collectedAt": row["수집일(KST)"], "observedAt": row["최근확인시각(KST)"],
            "caption": caption["캡션"], "captionStatus": caption["캡션 상태"], "captionObservedAt": caption.get("_caption_time") or caption["최근확인시각(KST)"],
            "attachmentStatus": latest.get("_latest_attachment_status") or latest["첨부 상태"], "runStatus": run.get("결과", "unknown"),
            "gapStatus": run.get("누락상태", "unknown"), "reasons": reasons,
            "source": row["_source"], "attachments": sorted(attachments.get(key, []), key=lambda x: x["ordinal"])})
    # Retain saved connections whose source JSONL was removed, without inventing captions.
    visible_keys = {(p["account"], p["postId"], item["ordinal"]) for p in posts for item in p["attachments"]}
    for key, link in links.items():
        if key in visible_keys:
            continue
        post = next((p for p in posts if (p["account"], p["postId"]) == key[:2]), None)
        if post is None:
            post = {"key": json.dumps(key[:2], ensure_ascii=False, separators=(",", ":")), "account": key[0], "postId": key[1],
                "originalUrl": "", "publishedAt": None, "collectedAt": None, "observedAt": None, "caption": "", "captionStatus": "unknown",
                "captionObservedAt": None, "attachmentStatus": "unknown", "runStatus": "unknown", "gapStatus": "unknown",
                "reasons": ["source_missing"], "source": "", "attachments": []}
            posts.append(post)
        if "source_missing" not in post["reasons"]:
            post["reasons"].append("attachment_source_missing")
        post["attachments"].append({"ordinal": key[2], "addressStatus": "missing", "observedAt": None, **link})
        post["attachments"].sort(key=lambda item: item["ordinal"])
    edits, comments, drafts = {}, {}, {}
    if state_status == "read_only":
        try:
            edits, edit_files, edit_warnings = read_edits(root, links, excluded_posts)
            files.extend(edit_files)
            warnings.extend(edit_warnings)
        except (SourceError, sqlite3.Error, ValueError, OSError, TypeError, KeyError):
            warnings.append({"code": "edits_unavailable", "message": "편집 결과 정보를 읽을 수 없습니다. 원본 첨부는 유지했습니다."})
        try:
            comments = read_comments(root, excluded_posts)
        except (SourceError, sqlite3.Error, ValueError, OSError, TypeError, KeyError):
            warnings.append({"code": "comments_unavailable", "message": "저장된 댓글 정보를 읽을 수 없습니다. 기존 댓글을 보존하려면 저장 상태를 확인하세요."})
        try:
            drafts = read_drafts(root, excluded_posts)
        except (SourceError, sqlite3.Error, ValueError, OSError, TypeError, KeyError):
            warnings.append({"code": "drafts_unavailable", "message": "등록 초안을 읽을 수 없습니다. 기존 초안을 보존하려면 저장 상태를 확인하세요."})
    for post in posts:
        post["downloadExcluded"] = False
        after = max((item["ordinal"] for item in post["attachments"]), default=0)
        post["edits"] = [{**item, "ordinal": after + index} for index, item in
                         enumerate(edits.get((post["account"], post["postId"]), []), 1)]
        if include_ai:
            try:
                originals = [item["mediaId"] for item in post["attachments"] if item["kind"] == "image"]
                generated, generated_files, generated_warnings = ai_media.read_post(root, post["key"], originals)
                offset = max((item["ordinal"] for item in [*post["attachments"], *post["edits"]]), default=0)
                post["aiImages"] = [{**item, "ordinal": offset + index} for index, item in enumerate(generated, 1)]
                files.extend(generated_files)
                warnings.extend(generated_warnings)
            except (SourceError, OSError, ValueError, TypeError):
                post["aiImages"] = []
                warnings.append({"code": "ai_media_unavailable", "message": "AI 생성 이미지를 확인하지 못했습니다. 기존 자료는 보존했습니다."})
        if (post["account"], post["postId"]) in comments:
            post["comment"] = comments[(post["account"], post["postId"])]
        if (post["account"], post["postId"]) in drafts:
            post["draft"] = drafts[(post["account"], post["postId"])]
    if excel_input.load_collection(root)["sources"] != source["sources"]:
        raise SourceError("source_changed", "읽는 중 원본 파일 구성이 변경되었습니다.")
    if state_stamp is not None and state_signature(root) != state_stamp:
        raise SourceError("state_changed", "읽는 중 상태 DB가 변경되었습니다.")
    idle(root, owned_lock)
    posts.sort(key=lambda p: (p["publishedAt"] or p["observedAt"] or "", p["account"], p["postId"]), reverse=True)
    return {"ok": True, "snapshot": {"root": str(root), "loadedAt": datetime.now(timezone.utc).isoformat(),
        "sourceCount": len(source["sources"]), "posts": posts, "warnings": warnings, "stateStatus": state_status}, "files": files}


def main(argv=None):
    parser = argparse.ArgumentParser(description="Read the local collection without changing it")
    parser.add_argument("--collection-root", required=True)
    parser.add_argument("--include-ai", action="store_true")
    args = parser.parse_args(argv)
    try:
        result = read_snapshot(args.collection_root, include_ai=args.include_ai)
    except (SourceError, InputError, StateError) as exc:
        result = {"ok": False, "error": {"code": exc.code, "message": str(exc)}}
    except Exception:
        result = {"ok": False, "error": {"code": "read_failed", "message": "자료를 읽지 못했습니다. 원본은 변경하지 않았습니다."}}
    print(json.dumps(result, ensure_ascii=False, allow_nan=False))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
