"""App-owned cleanup of unusable collection records, never download attempts.

Only records without any local work are tombstoned. Excel remains collection
history; jobs, request accounting, waits, source hashes and media stay untouched.
"""
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sqlite3
import time
import uuid

from . import attempts, batch, deletion_state, inspection, recovery, source_readiness
from .state import State, StateError, safe_path

META = "source_cleanup_history"


def _unavailable(data):
    result = []
    for post in data["posts"]:
        reason = source_readiness.reason(data, post)
        if reason:
            result.append({"account": post["계정명"], "postId": post["게시글ID"], "reason": reason,
                           "source": post["_source"], "sourceHash": post["_source_sha256"]})
    return result


def _releases(data, records):
    if not isinstance(records, list):
        raise StateError("invalid_download_exclusions", "이전 제외 기록의 형식을 확인해야 합니다.")
    posts = {(row["계정명"], row["게시글ID"]): row for row in data["posts"]}
    return [item for item in records if isinstance(item, dict) and
            (item.get("account"), item.get("postId")) in posts and
            source_readiness.reason(data, posts[(item["account"], item["postId"])]) is None]


def _protected(db):
    if db is None:
        return set()
    tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    keys = set()
    # Even a planned/failed/orphan media row owns resumable work. Never infer
    # eligibility for deletion from download completion or its error status.
    for table in ("media", "post_drafts", "post_comments", "media_edits"):
        if table in tables:
            keys.update((row[0], row[1]) for row in db.execute(f"SELECT account,post_id FROM {table}"))
    return keys


def _candidates(root, data, protected, library_id):
    result = []
    for item in _unavailable(data):
        key = item["account"], item["postId"]
        if key in protected:
            continue
        post_key = json.dumps(key, ensure_ascii=False, separators=(",", ":"))
        ai = safe_path(root, "ai-drafts/" + hashlib.sha256(post_key.encode()).hexdigest()[:32])
        if ai.exists() and any(ai.iterdir()):
            continue
        if library_id:
            folder = uuid.uuid5(uuid.UUID(library_id), key[0] + "\0" + key[1]).hex
            local = safe_path(root, f"media/files/{folder}")
            if local.exists() and any(local.iterdir()):
                continue
        result.append(item)
    return result


def _busy(meta, jobs):
    plan = meta.get(batch.META)
    return bool(meta.get("stop") or (plan and plan.get("status") != "complete") or
                any(job["status"] != "complete" for job in jobs))


def clean(root, *, clock=time.time):
    """Inspect first, then atomically hide only malformed source records; no HTTP."""
    root = Path(root)
    status = recovery.read_status(root, clock=clock)
    if status["problem"] or status["recoverable"]:
        return {**status, "cleanedPosts": 0, "releasedPosts": 0}
    initial = inspection.read_status(root, clock=clock)
    if initial["problem"] or _busy(initial["meta"], initial["jobs"]):
        return {**inspection.public_status(initial), "cleanedPosts": 0, "releasedPosts": 0}
    data = deletion_state.load_source(root)
    protected = set()
    database = safe_path(root, "state/state.db")
    if database.exists():
        with closing(sqlite3.connect(database.as_uri() + "?mode=ro&immutable=1", uri=True, timeout=0)) as db:
            db.execute("PRAGMA query_only=ON")
            protected = _protected(db)
    candidates = _candidates(root, data, protected, initial["meta"].get("library_id"))
    candidate_keys = {(item["account"], item["postId"]) for item in candidates}
    if any(not source_readiness.error_is_owned(error, candidate_keys) for error in data["errors"]):
        raise StateError("invalid_source", "글 단위로 확인할 수 없는 수집 원본 오류가 있어 자동 정리하지 않았습니다.")
    releases = _releases(data, initial["meta"].get("download_exclusions", []))
    if not candidates and not releases:
        return {**inspection.public_status(initial), "cleanedPosts": 0, "releasedPosts": 0}
    with State(root, clock=clock) as state:
        meta = {"stop": state.meta("stop"), batch.META: state.meta(batch.META)}
        jobs = attempts.current_jobs(state)
        if _busy(meta, jobs) or state.clock() < state.meta("last_clock", state.clock()) - 1:
            raise StateError("active_download", "기존 다운로드 상태를 먼저 확인하세요. 수집 자료와 파일을 보존했습니다.")
        batch._validate_saved(state)
        current = deletion_state.load_source(root, db=state.db)
        if current["sources"] != data["sources"]:
            raise StateError("source_changed", "정리 확인 중 수집 원본이 변경되어 보존했습니다.")
        candidates = _candidates(root, current, _protected(state.db), state.meta("library_id"))
        candidate_keys = {(item["account"], item["postId"]) for item in candidates}
        if any(not source_readiness.error_is_owned(error, candidate_keys) for error in current["errors"]):
            raise StateError("invalid_source", "연결된 작업이나 수집 원본 오류가 있어 자동 정리하지 않았습니다.")
        releases = _releases(current, state.meta("download_exclusions", []))
        if deletion_state.load_source(root, db=state.db)["sources"] != current["sources"]:
            raise StateError("source_changed", "정리 직전 수집 원본이 변경되어 보존했습니다.")
        if candidates or releases:
            when = datetime.fromtimestamp(state.clock(), timezone.utc).isoformat()
            with state.db:
                if candidates:
                    state.db.execute("CREATE TABLE IF NOT EXISTS post_deletions(account TEXT NOT NULL,post_id TEXT NOT NULL,deleted_at TEXT NOT NULL,PRIMARY KEY(account,post_id))")
                    for item in candidates:
                        state.db.execute("INSERT INTO post_deletions VALUES(?,?,?)", (item["account"], item["postId"], when))
                    state.set_meta(META, state.meta(META, []) + [{**item, "cleanedAt": when} for item in candidates])
                if releases:
                    state.set_meta("download_exclusions", [item for item in state.meta("download_exclusions", []) if item not in releases])
                    state.set_meta("source_cleanup_releases", state.meta("source_cleanup_releases", []) +
                                   [{**item, "releasedAt": when} for item in releases])
                    plan = state.meta(batch.META)
                    released = {(item["account"], item["postId"]) for item in releases}
                    if plan and any((item["account"], item["postId"]) in released for item in plan.get("skipped", [])):
                        plan["skipped"] = [item for item in plan["skipped"] if (item["account"], item["postId"]) not in released]
                        state.set_meta(batch.META, plan)
    return {**recovery.read_status(root, clock=clock), "cleanedPosts": len(candidates), "releasedPosts": len(releases)}
