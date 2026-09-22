"""One-file pilot orchestration; the production account/batch loop is separate."""
from __future__ import annotations

from contextlib import nullcontext
import hashlib
import json
import os
from pathlib import Path
import secrets
import time
import uuid
from urllib.parse import urlsplit

from . import attempts, deletion_state, excel_input, transport
from .state import State, StateError, POLICY, file_hash, safe_path, sync_directory


def _hash(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _summary(data):
    return {"source_files": len(data["sources"]), "posts": len(data["posts"]), "media": len(data["media"]),
            "errors": [{k: v for k, v in e.items() if k in ("code", "sheet", "row")} for e in data["errors"]],
            "warnings": len(data["warnings"])}


def inspect_source(root):
    data=deletion_state.load_source(root)
    accounts={}
    for run in sorted(data["runs"],key=lambda r:r.get("시작(KST)") or ""):
        if run.get("결과") in (excel_input.COMMITTED - {"partial"}) and not run.get("_blocked"):
            accounts[run["계정명"]]={"account":run["계정명"],"latest_run":run["실행ID"],
                 "next_anchor":run["다음기준ID"],"source":run["_source"]}
    return {**_summary(data),"accounts":list(accounts.values())}


def _source(root, *, db=None):
    try:
        data = deletion_state.load_source(root, db=db)
    except excel_input.InputError as exc:
        raise StateError(exc.code, str(exc)) from exc
    if not data["sources"] or data["errors"]:
        raise StateError("invalid_source", "확정된 Excel 수집 자료가 없거나 검증 오류가 있습니다.")
    return data


def _eligible_post(data, post, *, saved=lambda media: False):
    key = (post["계정명"], post["게시글ID"])
    run = next((r for r in data["runs"] if (r["계정명"], r["실행ID"]) ==
                (key[0], post["확인실행ID"])), None)
    media = sorted([m for m in data["media"] if (m["계정명"], m["게시글ID"]) == key], key=lambda m: m["순서"])
    if not run or run["결과"] not in (excel_input.COMMITTED - {"partial"}) or post.get("_blocked"):
        return []
    if (not media or [m["순서"] for m in media] != list(range(1, len(media)+1)) or
            any((m.get("_blocked") or m["주소상태"] != "http_candidate" or not m["다운로드URL"]) and not saved(m) for m in media)):
        return []
    if sum(m["종류"] == "image" for m in media) != post["이미지 수"] or sum(m["종류"] == "video" for m in media) != post["영상 수"]:
        return []
    return media


def _completed(state, media_id, *, deleted=None):
    row = state.db.execute("SELECT j.*,m.account,m.post_id FROM jobs j JOIN media m USING(media_id) WHERE media_id=? AND status='complete'", (media_id,)).fetchone()
    if row:
        deleted = deleted if deleted is not None else deletion_state.deleted_posts(state.root, db=state.db)
        if (row["account"], row["post_id"]) in deleted:
            return row
        try:
            path = safe_path(state.root, row["final_rel"], require_file=True)
            valid = path.stat().st_size == row["size"] and file_hash(path) == row["sha256"]
        except (StateError, OSError):
            valid = False
        if not valid:
            state.stop("completed_file_changed", requires_review=True)
            raise StateError("completed_file_changed", "완료 파일이 삭제되거나 변경되었습니다.")
    return row


def _unfinished(state):
    if attempts.current_jobs(state, {'running', 'staged', 'failed', 'interrupted'}):
        raise StateError("recovery_required", "미완료 작업이 있습니다. 새 작업 전에 복구가 필요합니다.")


def plan_one(root, account, *, expected=None):
    deletion_state.require_no_pending(root)
    with State(root) as state:
        state.guard()
        _unfinished(state)
        pending = next(iter(attempts.current_jobs(state, {'planned'})), None)
        if pending:
            if pending["account"] != account:
                raise StateError("pending_other_account", "다른 계정의 기존 작업을 먼저 확인하세요.")
            if expected is not None:
                job = state.db.execute("SELECT j.*,m.account,m.post_id,m.ordinal,m.kind FROM jobs j JOIN media m USING(media_id) WHERE job_id=?", (pending["job_id"],)).fetchone()
                actual = {"account": job["account"], "postId": job["post_id"], "ordinal": job["ordinal"], "kind": job["kind"], "source": job["source_rel"], "sourceHash": job["source_sha256"], "runId": job["run_id"], "urlHash": job["url_hash"]}
                if job["source_type"] != "xlsx" or actual != expected:
                    raise StateError("source_changed", "확인한 대상과 기존 계획이 다릅니다.")
            return {"job_id": pending["job_id"], "status": "already_planned", "network_requests": 0}
        data = _source(state.root, db=state.db)
        deleted = deletion_state.deleted_posts(state.root, db=state.db, sources=data['sources'])
        posts = sorted([p for p in data["posts"] if p["계정명"] == account],
                       key=lambda p: (p.get("등록일(KST)") or p["수집일(KST)"], p["게시글ID"]))
        for post in posts:
            for media in _eligible_post(data, post):
                key = (account, post["게시글ID"], media["순서"])
                row = state.db.execute("SELECT * FROM media WHERE account=? AND post_id=? AND ordinal=?", key).fetchone()
                media_id = row["media_id"] if row else uuid.uuid4().hex
                if row and row["kind"] != media["종류"]:
                    raise StateError("media_conflict", "기존 첨부의 종류가 변경되었습니다.")
                if _completed(state, media_id, deleted=deleted):
                    continue
                if expected is not None:
                    from .inspection import candidate
                    if candidate(post, media) != expected:
                        raise StateError("source_changed", "확인한 대상이 변경되었습니다. 다시 확인하세요.")
                transport.dependencies(media["종류"])
                job_id = uuid.uuid4().hex
                now = state.clock()
                with state.db:
                    state.db.execute("INSERT OR IGNORE INTO media VALUES(?,?,?,?,?)", (media_id, *key, media["종류"]))
                    state.db.execute("""INSERT INTO jobs(job_id,media_id,source_rel,source_sha256,source_type,
                      run_id,url_hash,status,part_rel,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
                      (job_id, media_id, media["_source"], media["_source_sha256"], "xlsx",
                       media["확인실행ID"], _hash(media["다운로드URL"]), "planned", f"media/.partial/{job_id}.part", now, now))
                return {"job_id": job_id, "status": "planned", "account": account,
                        "post_id": key[1], "ordinal": key[2], "kind": media["종류"],
                        "mode": POLICY["name"], "planned_files": 1, "post_complete": False,
                        "network_requests": 0}
        raise StateError("no_ready_media", "다운로드 가능한 미완료 게시글 첨부가 없습니다.")


def _publish(state, row):
    part = safe_path(state.root, row["part_rel"])
    final = safe_path(state.root, row["final_rel"])
    final.parent.mkdir(parents=True, exist_ok=True)
    current = final if final.exists() else part
    safe_path(state.root, current.relative_to(state.root).as_posix())
    if not current.is_file() or (current.stat().st_nlink != 1 and not (
            current.stat().st_nlink == 2 and part.is_file() and final.is_file() and os.path.samefile(part, final))):
        raise StateError("invalid_file", "저장 준비 파일 연결이 올바르지 않습니다.")
    if current.stat().st_size != row["size"] or file_hash(current) != row["sha256"]:
        raise StateError("staged_file_changed", "저장 준비 파일의 크기·해시가 다릅니다.")
    if not final.exists():
        os.link(part, final)  # Same filesystem, exclusive destination; never overwrite.
    if part.exists():
        if not os.path.samefile(part, final):
            raise StateError("staged_file_conflict", "임시 파일과 확정 파일이 충돌합니다.")
        part.unlink()
    for directory in (final.parent, final.parent.parent, part.parent, state.media_dir):
        sync_directory(directory)
    with state.db:
        state.db.execute("UPDATE jobs SET status='complete',updated_at=? WHERE job_id=?", (state.clock(), row["job_id"]))
        # The deadline survives exit/restart even though this pilot has no next file.
        state.set_meta("next_allowed", max(state.meta("next_allowed", 0), state.clock() + 3 + secrets.randbelow(7001)/1000))
        # Batch cursor and boundary waits commit with the completed file.
        from .batch import record_completion
        record_completion(state, row["job_id"])
    return {"job_id": row["job_id"], "status": "complete", "path": str(final), "size": row["size"],
            "sha256": row["sha256"], "width": row["width"], "height": row["height"], "post_complete": False,
            "next_allowed_at": state.meta("next_allowed")}


def download_one(root, job_id, *, cancel=lambda: False, download=transport.download, state=None, source_guard=lambda: None):
    deletion_state.require_no_pending(root)
    with (nullcontext(state) if state is not None else State(root)) as state:
        row = state.db.execute("SELECT j.*,m.account,m.post_id,m.ordinal,m.kind FROM jobs j JOIN media m USING(media_id) WHERE job_id=?", (job_id,)).fetchone()
        if not row:
            raise StateError("job_missing", "다운로드 계획이 없습니다.")
        if (row["account"], row["post_id"]) in deletion_state.deleted_posts(state.root, db=state.db):
            raise StateError("post_deleted", "삭제한 게시글은 다운로드하지 않습니다.")
        if row["status"] == "complete":
            _completed(state, row["media_id"])
            return {"job_id": job_id, "status": "already_complete", "network_requests": 0,
                    "path": str(safe_path(state.root, row["final_rel"]))}
        state.guard()
        if row["status"] != "planned":
            raise StateError("recovery_required", "새 요청 전에 미완료 작업 확인이 필요합니다.")
        _unfinished(state)
        if cancel():
            raise StateError("cancelled", "사용자 중지로 전송하지 않았습니다.")
        try:
            source_guard()
            data = _source(state.root, db=state.db)
            post = next(p for p in data["posts"] if (p["계정명"],p["게시글ID"]) == (row["account"],row["post_id"]))
            def saved(media):
                return state.db.execute("""SELECT 1 FROM media m JOIN jobs j USING(media_id)
                    WHERE account=? AND post_id=? AND ordinal=? AND j.status='complete'""",
                    (media["계정명"], media["게시글ID"], media["순서"])).fetchone() is not None
            media = next(m for m in _eligible_post(data, post, saved=saved) if m["순서"] == row["ordinal"])
            if (row["source_type"] != "xlsx" or media["_source"] != row["source_rel"] or media["_source_sha256"] != row["source_sha256"] or
                    media["확인실행ID"] != row["run_id"] or _hash(media["다운로드URL"]) != row["url_hash"]):
                raise StateError("source_changed", "계획 이후 수집 원본이 변경되었습니다.")
            transport.dependencies(row["kind"])
            with state.db:
                state.db.execute("UPDATE jobs SET status='running',updated_at=? WHERE job_id=?", (state.clock(),job_id))
            def before_request(url, hop):
                if cancel():
                    raise StateError("cancelled", "사용자 중지로 전송하지 않았습니다.")
                source_guard()
                source = safe_path(state.root, row["source_rel"], require_file=True)
                if file_hash(source) != row["source_sha256"]:
                    raise StateError("source_changed", "전송 직전 수집 원본이 변경되었습니다.")
                state.reserve_request(job_id, _hash(url), urlsplit(url).hostname, hop)
            def pause(seconds):
                state.wait_until(state.clock()+seconds)
                until = time.monotonic()+seconds
                while time.monotonic() < until:
                    if cancel():
                        raise StateError("cancelled", "대기 중 사용자가 중지했습니다.")
                    time.sleep(min(.2, max(0,until-time.monotonic())))
            result = download(media["다운로드URL"], safe_path(state.root,row["part_rel"]),row["kind"],
                              before_request=before_request,pause=pause,max_redirects=0,cancel=cancel)
            if cancel():
                raise StateError("cancelled", "파일 저장 확정 전에 중지했습니다.")
            source_guard()
            if file_hash(safe_path(state.root,row["source_rel"],require_file=True)) != row["source_sha256"]:
                raise StateError("source_changed", "전송 중 수집 원본이 변경되었습니다.")
            if result["extension"] not in ("jpg","jpeg","png","webp","gif","mp4"):
                raise StateError("invalid_media", "지원하지 않는 저장 확장자입니다.")
            post_uuid = uuid.uuid5(uuid.UUID(state.meta("library_id")), row["account"]+"\0"+row["post_id"]).hex
            final_rel = f"media/files/{post_uuid}/{row['media_id']}.{result['extension']}"
            with state.db:
                state.db.execute("""UPDATE jobs SET status='staged',final_rel=?,size=?,sha256=?,extension=?,width=?,height=?,updated_at=? WHERE job_id=?""",
                  (final_rel,result["size"],result["sha256"],result["extension"],result.get("width"),result.get("height"),state.clock(),job_id))
                state.db.execute("UPDATE jobs SET http_status=200,content_type=? WHERE job_id=?", (result.get("content_type"),job_id))
                state.db.execute("UPDATE requests SET http_status=200,content_type=? WHERE id=(SELECT max(id) FROM requests WHERE job_id=?)", (result.get("content_type"),job_id))
            ready = state.db.execute("SELECT * FROM jobs WHERE job_id=?",(job_id,)).fetchone()
            return _publish(state,ready)
        except BaseException as exc:
            code = getattr(exc,"code","interrupted" if isinstance(exc,KeyboardInterrupt) else "download_failed")
            with state.db:
                state.db.execute("UPDATE jobs SET http_status=coalesce(?,http_status) WHERE job_id=?",(getattr(exc,"status",None),job_id))
                state.db.execute("UPDATE requests SET http_status=coalesce(?,http_status) WHERE id=(SELECT max(id) FROM requests WHERE job_id=?)",(getattr(exc,"status",None),job_id))
            current = state.db.execute("SELECT status FROM jobs WHERE job_id=?",(job_id,)).fetchone()[0]
            if current not in ("staged","complete"):
                with state.db:
                    state.db.execute("UPDATE jobs SET status='failed',error_code=?,updated_at=? WHERE job_id=?",(code,state.clock(),job_id))
            state.stop(code,retry_at=getattr(exc,"retry_at",None),requires_review=True)
            raise


def recover(root, *, state=None, clock=time.time):
    """Only finish locally verified staged files; never send another request."""
    deletion_state.require_no_pending(root)
    with (nullcontext(state) if state is not None else State(root, clock=clock)) as state:
        results=[]
        for row in attempts.current_jobs(state, {'running', 'staged'}):
            if row["status"] == "staged":
                results.append(_publish(state,row))
            else:
                with state.db:
                    state.db.execute("UPDATE jobs SET status='interrupted',error_code='interrupted' WHERE job_id=?",(row["job_id"],))
                if not state.meta("stop"):
                    state.stop("interrupted",requires_review=True)
        return {"recovered":results,"network_requests":0,"stop":state.meta("stop")}


def status(root):
    if not (root / "state/state.db").exists():
        return {"initialized":False,"policy":POLICY,"jobs":[],"requests_24h":0}
    with State(root) as state:
        fields = ('job_id', 'status', 'error_code', 'http_status', 'content_type', 'final_rel', 'size', 'account', 'post_id', 'ordinal', 'kind')
        jobs = [{key: row[key] for key in fields} for row in deletion_state.active_jobs(state)]
        return {"policy":POLICY,"jobs":jobs,"stop":state.meta("stop"),"next_allowed_at":state.meta("next_allowed"),
                "requests_24h":state.db.execute("SELECT count(*) FROM requests WHERE consumed_at>?",(state.clock()-86400,)).fetchone()[0],
                "state_path":str(state.state_dir/"state.db"),"media_root":str(state.media_dir)}
