"""Finite, durable whole-post batches sharing the single-file transfer engine."""
from __future__ import annotations

from collections import Counter
import secrets
import time
import uuid

from . import attempts, deletion_state, inspection, recovery, resume, runner, source_readiness, transport
from .state import POLICY, State, StateError, safe_path

META = "download_batch"
REASONS = {
    "source_not_ready": "수집 원본 확인 필요",
    "attachment_not_ready": "첨부 주소 또는 순서 확인 필요",
    "round_range": "회차 범위 확인 필요",
}


def public_batch(plan):
    targets = plan["targets"]
    completed = plan["nextIndex"]
    finished_posts = sum(1 for index, item in enumerate(targets[:completed]) if item["lastInPost"])
    return {"totalPosts": plan["totalPosts"], "completedPosts": finished_posts,
            "totalFiles": len(targets), "completedFiles": completed,
            "totalRounds": plan["totalRounds"],
            "currentRound": targets[min(completed, len(targets)-1)]["round"] if targets else 0,
            "deferredPosts": len(plan["deferred"]), "skippedPosts": len(plan.get("skipped", []))}


def _sample(name):
    low, high = POLICY[name]
    return low + secrets.randbelow(int((high-low)*1000)+1)/1000


def record_completion(state, job_id):
    """Called inside the same transaction that marks a file complete, also on recovery."""
    plan = state.meta(META)
    if not plan or plan.get("status") == "complete":
        return
    targets = plan["targets"]
    index = next((i for i, target in enumerate(targets) if target["jobId"] == job_id), None)
    if index is None or index < plan["nextIndex"]:
        return
    if index != plan["nextIndex"]:
        raise StateError("batch_order_changed", "저장된 다운로드 순서가 맞지 않습니다.")
    target = targets[index]
    now = state.clock()
    waits = {}
    if target["lastInRound"]:
        waits["roundWaitSeconds"] = _sample("round_wait_seconds")
    if target["lastInAccount"]:
        waits["accountWaitSeconds"] = _sample("account_wait_seconds")
    if waits:
        next_allowed = max(state.meta("next_allowed", 0), *(now + seconds for seconds in waits.values()))
        state.set_meta("next_allowed", next_allowed)
        plan["boundary"] = {"jobId": job_id, "completedAt": now, "nextAllowedAt": next_allowed, **waits}
    plan["nextIndex"] = index + 1
    plan["status"] = "complete" if index + 1 == len(targets) else "active"
    state.set_meta(META, plan)


def _validate_saved(state, cache=None):
    deleted = deletion_state.deleted_posts(state.root, db=state.db)
    for row in deletion_state.active_jobs(state, {'complete'}, deleted=deleted):
        try:
            path = safe_path(state.root, row["final_rel"], require_file=True)
            info = path.stat()
            stamp = (row["final_rel"], row["sha256"], row["size"], info.st_dev, info.st_ino,
                     info.st_size, info.st_mtime_ns, info.st_ctime_ns)
        except (StateError, OSError):
            stamp = None
        if cache is None or stamp is None or cache.get(row["media_id"]) != stamp:
            runner._completed(state, row["media_id"], deleted=deleted)
            if cache is not None:
                cache[row["media_id"]] = stamp


def _prepare_posts(state, data):
    ready, deferred = [], []
    deleted = deletion_state.deleted_posts(state.root, db=state.db, sources=data['sources'])
    posts = sorted(data["posts"], key=lambda p: (p["계정명"], p.get("등록일(KST)") or p["수집일(KST)"], p["게시글ID"]))
    for post in posts:
        key = (post["계정명"], post["게시글ID"])
        media = sorted([item for item in data["media"] if (item["계정명"], item["게시글ID"]) == key], key=lambda item: item["순서"])
        remaining = []
        for item in media:
            previous = state.db.execute("SELECT * FROM media WHERE account=? AND post_id=? AND ordinal=?", (*key, item["순서"])).fetchone()
            if previous and previous["kind"] != item["종류"]:
                raise StateError("media_conflict", "기존 첨부의 종류가 변경되었습니다.")
            if previous and runner._completed(state, previous["media_id"], deleted=deleted):
                continue
            remaining.append((item, previous["media_id"] if previous else uuid.uuid4().hex))
        if media and not remaining:
            continue
        remaining_orders = {item["순서"] for item, _ in remaining}
        reason = source_readiness.reason(data, post, media, saved=lambda item: item["순서"] not in remaining_orders)
        if reason:
            deferred.append({"account": key[0], "postId": key[1], "reason": reason})
        else:
            ready.append({"account": key[0], "postId": key[1], "targets": [
                {**inspection.candidate(post, media), "mediaId": media_id} for media, media_id in remaining]})
    return ready, deferred


def whole_post_rounds(posts):
    """Largest consecutive whole-post groups; never skip a blocked round boundary."""
    low, high = POLICY["round_files"]
    rounds, group, size = [], [], 0
    for index, post in enumerate(posts):
        count = len(post["targets"])
        if group and (post["account"] != group[0]["account"] or size + count > high):
            account_ended = post["account"] != group[0]["account"]
            if not account_ended and size < low:
                return rounds, group + posts[index:]
            rounds.append(group)
            group, size = [], 0
        if count > high:
            return rounds, posts[index:]
        group.append(post)
        size += count
    if group:
        rounds.append(group)
    return rounds, []


def _source_guard(state, plan):
    if runner._source(state.root, db=state.db)["sources"] != plan["sources"]:
        raise StateError("source_changed", "계획 이후 수집 원본이 변경되었습니다. 기존 계획과 저장 파일을 보존했습니다.")


def _validate_plan(state, plan):
    if plan.get("version") != 1 or plan.get("policy") != POLICY or plan.get("status") != "active":
        raise StateError("batch_policy_changed", "기존 다운로드 계획의 정책 또는 중단 상태를 확인해야 합니다.")
    targets = plan.get("targets")
    cursor = plan.get("nextIndex")
    if (not isinstance(targets, list) or not targets or type(cursor) is not int or not 0 <= cursor < len(targets)):
        raise StateError("invalid_batch", "저장된 다운로드 계획을 확인해야 합니다.")
    ids = set()
    deleted = deletion_state.deleted_posts(state.root, db=state.db)
    for index, target in enumerate(targets):
        job = state.db.execute("SELECT j.*,m.account,m.post_id,m.ordinal,m.kind FROM jobs j JOIN media m USING(media_id) WHERE job_id=?", (target["jobId"],)).fetchone()
        if index >= cursor and (target["account"], target["postId"]) in deleted:
            raise StateError("post_deleted", "저장된 계획에 삭제한 게시글이 있습니다. 기존 계획을 확인하세요.")
        if (not job or target["jobId"] in ids or job["status"] != ("complete" if index < cursor else "planned") or
                job["source_type"] != "xlsx" or job["source_rel"] != target["source"] or
                job["source_sha256"] != target["sourceHash"] or job["run_id"] != target["runId"] or job["url_hash"] != target["urlHash"] or
                (job["account"], job["post_id"], job["ordinal"], job["kind"], job["media_id"]) !=
                (target["account"], target["postId"], target["ordinal"], target["kind"], target["mediaId"])):
            raise StateError("invalid_batch", "저장된 계획과 첨부 작업의 연결이 다릅니다.")
        ids.add(target["jobId"])
    if any(row['job_id'] not in ids for row in attempts.current_jobs(state, {'planned'}, deleted=deleted)):
        raise StateError("pending_plan_conflict", "저장된 회차 밖의 미완료 계획을 먼저 확인하세요.")
    _source_guard(state, plan)


def _persist_plan(state):
    data = runner._source(state.root, db=state.db)
    ready, deferred = _prepare_posts(state, data)
    rounds, blocked = whole_post_rounds(ready)
    deferred += [{"account": post["account"], "postId": post["postId"], "reason": "round_range"} for post in blocked]
    targets = []
    for number, group in enumerate(rounds, 1):
        for post in group:
            for index, target in enumerate(post["targets"]):
                targets.append({**target, "round": number, "lastInPost": index == len(post["targets"])-1,
                    "lastInRound": post is group[-1] and index == len(post["targets"])-1,
                    "lastInAccount": post is group[-1] and index == len(post["targets"])-1 and
                        (number == len(rounds) or rounds[number][0]["account"] != post["account"])})
    for kind in {target["kind"] for target in targets}:
        transport.dependencies(kind)
    existing = {row["media_id"]: row for row in attempts.current_jobs(state, {'planned'})}
    if any(media_id not in {target["mediaId"] for target in targets} for media_id in existing):
        raise StateError("pending_plan_conflict", "기존 단일 파일 계획과 이번 대상이 다릅니다. 기존 작업을 먼저 확인하세요.")
    plan = {"version": 1, "id": uuid.uuid4().hex, "policy": POLICY, "sources": data["sources"], "targets": targets,
            "totalPosts": sum(len(group) for group in rounds), "totalRounds": len(rounds), "nextIndex": 0,
            "deferred": deferred, "status": "active" if targets else "complete", "createdAt": state.clock()}
    _source_guard(state, plan)
    with state.db:
        for target in targets:
            previous = existing.get(target["mediaId"])
            if previous:
                if (previous["source_type"] != "xlsx" or previous["source_rel"] != target["source"] or
                        previous["source_sha256"] != target["sourceHash"] or previous["run_id"] != target["runId"] or previous["url_hash"] != target["urlHash"]):
                    raise StateError("source_changed", "기존 미완료 계획의 원본을 자동 교체하지 않습니다.")
                target["jobId"] = previous["job_id"]
                continue
            job_id = uuid.uuid4().hex
            target["jobId"] = job_id
            state.db.execute("INSERT OR IGNORE INTO media VALUES(?,?,?,?,?)", (target["mediaId"], target["account"], target["postId"], target["ordinal"], target["kind"]))
            state.db.execute("""INSERT INTO jobs(job_id,media_id,source_rel,source_sha256,source_type,
                run_id,url_hash,status,part_rel,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
                (job_id, target["mediaId"], target["source"], target["sourceHash"], "xlsx", target["runId"],
                    target["urlHash"], "planned", f"media/.partial/{job_id}.part", state.clock(), state.clock()))
        state.set_meta(META, plan)
    return plan


def _result(state, plan, problem=None, completed_since=None):
    next_allowed = state.meta("next_allowed", 0)
    completed_keys = [] if completed_since is None or plan["status"] != "complete" else [
        [target["account"], target["postId"]] for target in plan["targets"][completed_since:plan["nextIndex"]]
        if target["lastInPost"]]
    return {"nextAllowedAt": next_allowed if next_allowed > state.clock() else None, "problem": problem,
            "recoverable": bool(attempts.current_jobs(state, {'running', 'staged'})),
            "resumable": resume.possible({META: plan, "stop": state.meta("stop")}) and state.clock() >= state.meta("last_clock", state.clock()) - 1,
            "batch": public_batch(plan), "_completedPostKeys": completed_keys}


def _deferred_problem(plan):
    counts = Counter(item["reason"] for item in plan["deferred"])
    if not counts:
        return None
    detail = ", ".join(f"{REASONS[reason]} {count}개" for reason, count in sorted(counts.items()))
    return {"code": "posts_deferred", "message": f"다운로드 가능한 게시글을 처리했습니다. 보류 {len(plan['deferred'])}개: {detail}."}


def run(root, cancel, *, transfer=None, output=lambda event: None, clock=time.time, sleep=time.sleep, monotonic=time.monotonic, resume_requested=False):
    """The only entry starts on an explicit app command; opening/recovery never calls it."""
    if cancel():
        raise StateError("cancelled", "사용자 중지로 다운로드하지 않았습니다.")
    if resume_requested:
        # This explicit action may release only a provably dead download lock.
        recovery.release_abandoned(root)
    else:
        # Read-only validation happens before opening the writer, including corrupt DB/WAL handling.
        initial = inspection.read_status(root, clock=clock)
        if initial["problem"]:
            return inspection.public_status(initial)
        source = deletion_state.load_source(root)
        if source["errors"]:
            raise StateError("invalid_source", "확정된 Excel 수집 자료에 검증 오류가 있습니다.")
        # A fully saved collection is a read-only no-op, even while the last wait persists.
        post_keys = {(post["계정명"], post["게시글ID"]) for post in source["posts"]}
        media_keys = {(item["계정명"], item["게시글ID"]) for item in source["media"]}
        if not any(job["status"] == "planned" for job in initial["jobs"]) and (not source["posts"] or (post_keys <= media_keys and all(
                initial["links"].get((item["계정명"], item["게시글ID"], item["순서"]), {}).get("status") == "saved" and
                initial["links"][(item["계정명"], item["게시글ID"], item["순서"])]["kind"] == item["종류"]
                for item in source["media"]))):
            return {**inspection.public_status(initial), "batch": {"totalPosts": 0, "completedPosts": 0,
                "totalFiles": 0, "completedFiles": 0, "totalRounds": 0, "currentRound": 0, "deferredPosts": 0, "skippedPosts": 0}}
    with State(root, clock=clock) as state:
        saved_stamps = {}
        if resume_requested:
            plan = state.meta(META)
            completed_since = plan.get("nextIndex") if isinstance(plan, dict) and type(plan.get("nextIndex")) is int else None
            try:
                if not resume.possible({META: plan, "stop": state.meta("stop")}):
                    raise StateError("resume_review_required", "현재 중단 사유 또는 다운로드 계획을 먼저 확인해야 합니다.")
                runner.recover(root, state=state, clock=clock)
                if cancel():
                    raise StateError("cancelled", "앱 종료로 다운로드하지 않았습니다.")
                plan = resume.revalidate(state, recovered_complete=True)
            except (StateError, transport.TransferError) as exc:
                # Keep the original stop/history on failed revalidation. Repeated
                # clicks may inspect repaired source data, but cannot reset policy.
                if plan:
                    return _result(state, state.meta(META), {"code": exc.code, "message": str(exc)})
                raise
            if plan["status"] == "complete":
                return _result(state, plan, _deferred_problem(plan), completed_since)
        else:
            try:
                state.guard()
            except StateError as exc:
                if exc.code != "waiting":
                    raise
            runner._unfinished(state)
            _validate_saved(state, saved_stamps)
            plan = state.meta(META)
            if plan and plan.get("status") != "complete":
                try:
                    _validate_plan(state, plan)
                except StateError as exc:
                    state.stop(exc.code, requires_review=True)
                    return _result(state, plan, {"code": exc.code, "message": str(exc)})
            else:
                plan = _persist_plan(state)
            completed_since = plan["nextIndex"]
        last_emit = -float("inf")

        def emit(phase, received=0, total=None, target=None):
            nonlocal last_emit
            now = monotonic()
            if now-last_emit < .15:
                return
            event = {"type": "progress", "phase": phase, "received": received, "total": total,
                "batch": public_batch(state.meta(META))}
            if target:
                event["target"] = {key: target[key] for key in ("account", "postId", "ordinal", "kind")}
            deadline = state.meta("next_allowed", 0)
            event["nextAllowedAt"] = deadline if deadline > state.clock() else None
            output(event)
            last_emit = now

        try:
            emit("checking")
            while plan["nextIndex"] < len(plan["targets"]):
                target = plan["targets"][plan["nextIndex"]]
                _source_guard(state, plan)
                _validate_saved(state, saved_stamps)
                while state.clock() < state.meta("next_allowed", 0):
                    if cancel():
                        raise StateError("cancelled", "대기 중 다운로드를 중지했습니다.")
                    if state.clock() < state.meta("last_clock", state.clock()) - 1:
                        raise StateError("clock_rollback", "컴퓨터 시각이 이전 실행보다 과거입니다.")
                    emit("waiting", target=target)
                    seconds = min(.2, state.meta("next_allowed", 0)-state.clock())
                    wall_before, monotonic_before = state.clock(), monotonic()
                    sleep(seconds)
                    wall_gap, monotonic_gap = state.clock()-wall_before, monotonic()-monotonic_before
                    if wall_gap-monotonic_gap > 2 or wall_gap > seconds+10:
                        raise StateError("system_resume", "긴 일시 정지 또는 절전 복귀를 감지해 다운로드를 중단했습니다.")
                state.guard()
                if cancel():
                    raise StateError("cancelled", "사용자 중지로 다운로드하지 않았습니다.")
                _source_guard(state, plan)
                _validate_saved(state, saved_stamps)

                def download(*args, **kwargs):
                    emit("downloading", target=target)
                    return (transfer or transport.download)(*args, **kwargs,
                        progress=lambda phase, received, total: emit(phase, received, total, target))

                runner.download_one(state.root, target["jobId"], cancel=cancel, download=download, state=state,
                    source_guard=lambda: _source_guard(state, plan))
                plan = state.meta(META)
                emit("checking", target=target)
            return _result(state, plan, _deferred_problem(plan), completed_since)
        except BaseException as exc:
            code = getattr(exc, "code", "interrupted" if isinstance(exc, KeyboardInterrupt) else "download_failed")
            state.stop(code, retry_at=getattr(exc, "retry_at", None), requires_review=True)
            plan = state.meta(META)
            plan["status"] = "stopped"
            state.set_meta(META, plan)
            state.db.commit()
            safe = isinstance(exc, (StateError, transport.TransferError))
            return _result(state, plan, {"code": code, "message": str(exc) if safe else "다운로드를 중단했습니다. 기존 파일과 계획은 보존했습니다."})
