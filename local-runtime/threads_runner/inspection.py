"""Read-only download preparation. No state initialization or network requests."""
from contextlib import closing
from pathlib import Path
import sqlite3
import time
import json

from . import attempts, deletion_state, runner, transport
from .state import StateError, supported_policy


def read_status(root, *, clock=time.time):
    import collection_view as view
    root = view.collection_root(Path(root))
    view.idle(root)
    deletion_state.require_no_pending(root)
    excluded_posts = deletion_state.excel_deletions(root)
    links, files, state, signature = view.read_state(root, excluded_posts)
    meta, jobs = {}, []
    if state != 'absent':
        path = view.safe_path(root, 'state/state.db', require_file=True)
        with closing(sqlite3.connect(path.as_uri() + '?mode=ro&immutable=1', uri=True, timeout=0)) as db:
            db.row_factory = sqlite3.Row
            db.execute('PRAGMA query_only=ON')
            db.execute('PRAGMA trusted_schema=OFF')
            meta = {row['key']: json.loads(row['value']) for row in db.execute('SELECT * FROM meta')}
            jobs = [dict(row) for row in db.execute('SELECT j.*,m.account,m.post_id,m.ordinal,m.kind FROM jobs j JOIN media m USING(media_id)')]
            excluded_posts |= deletion_state.database_deletions(root, db)[0]
            retired = attempts.retired_ids(db)
            jobs = [job for job in jobs if (job['account'], job['post_id']) not in excluded_posts and job['job_id'] not in retired]
        if not supported_policy(meta.get('policy')):
            raise StateError('policy_mismatch', '저장된 요청 제한과 실행기 설정이 다릅니다.')
    if signature != view.state_signature(root):
        raise StateError('state_changed', '확인 중 다운로드 상태가 변경되었습니다.')
    view.idle(root)
    now = clock()
    problem = None
    if meta.get('stop'):
        problem = {'code': 'stopped', 'message': '이전 오류로 다운로드가 중단돼 있습니다. 저장 복구는 재전송하거나 중단을 해제하지 않습니다.'}
    elif now < meta.get('last_clock', now) - 1:
        problem = {'code': 'clock_rollback', 'message': '컴퓨터 시각이 이전 실행보다 과거입니다. 시각을 확인하세요.'}
    elif any(job['status'] in {'running', 'staged', 'failed', 'interrupted'} for job in jobs):
        problem = {'code': 'recovery_required', 'message': '미완료 작업을 먼저 확인해야 합니다. 로컬 저장 복구를 실행하세요.'}
    elif any(link['status'] == 'review' and link.get('reason') != 'planned' for link in links.values()):
        problem = {'code': 'local_file_changed', 'message': '기존 저장 파일의 연결 또는 내용이 달라졌습니다. 파일을 보존하고 확인하세요.'}
    next_allowed = meta.get('next_allowed', 0)
    return {'nextAllowedAt': next_allowed if next_allowed > now else None, 'problem': problem,
            'recoverable': any(j['status'] in {'running', 'staged'} for j in jobs),
            'jobs': jobs, 'links': links, 'signature': signature, 'meta': meta}


def candidate(post, media):
    return {'account': media['계정명'], 'postId': media['게시글ID'], 'ordinal': media['순서'], 'kind': media['종류'],
            'source': media['_source'], 'sourceHash': media['_source_sha256'],
            'runId': media['확인실행ID'], 'urlHash': runner._hash(media['다운로드URL'])}


def public_status(status):
    from . import batch, resume
    result = {key: status[key] for key in ('nextAllowedAt', 'problem', 'recoverable')}
    meta = status.get('meta', {})
    result['resumable'] = resume.possible(meta) and (result.get('problem') or {}).get('code') != 'clock_rollback'
    plan = meta.get(batch.META)
    if plan:
        result['batch'] = batch.public_batch(plan)
        cursor = plan['nextIndex']
        if cursor < len(plan['targets']):
            result['target'] = {key: plan['targets'][cursor][key] for key in ('account', 'postId', 'ordinal', 'kind')}
    return result


def preview_one(root, account, *, clock=time.time):
    import collection_view as view
    root = view.collection_root(Path(root))
    status = read_status(root, clock=clock)
    result = {**public_status(status), 'target': None, 'plan': None}
    if status['problem']:
        return result
    data = runner._source(root)
    pending = [j for j in status['jobs'] if j['status'] == 'planned']
    if len(pending) > 1 or (pending and pending[0]['account'] != account):
        raise StateError('pending_other_account', '다른 계정 또는 여러 미완료 계획이 있습니다. 기존 작업을 먼저 확인하세요.')
    selected = None
    posts = sorted([p for p in data['posts'] if p['계정명'] == account],
                   key=lambda p: (p.get('등록일(KST)') or p['수집일(KST)'], p['게시글ID']))
    for post in posts:
        for media in runner._eligible_post(data, post):
            key = (account, post['게시글ID'], media['순서'])
            if status['links'].get(key, {}).get('status') == 'saved':
                continue
            if pending and (post['게시글ID'], media['순서']) != (pending[0]['post_id'], pending[0]['ordinal']):
                continue
            selected = candidate(post, media)
            if pending:
                job = pending[0]
                if (job['source_type'] != 'xlsx' or job['source_rel'] != selected['source'] or
                        job['source_sha256'] != selected['sourceHash'] or job['run_id'] != selected['runId'] or job['url_hash'] != selected['urlHash']):
                    raise StateError('source_changed', '기존 계획의 원본이 변경되었습니다. 계획을 자동 교체하지 않습니다.')
            # This validates syntax/allowlist only. No DNS, HEAD or GET.
            for attachment in runner._eligible_post(data, post):
                transport.validate_url(attachment['다운로드URL'])
            break
        if selected:
            break
    if selected is None:
        raise StateError('no_ready_media', '다운로드할 수 있는 미완료 첨부가 없습니다. 주소·수집 상태를 확인하세요.')
    result.update(plan=selected, target={k: selected[k] for k in ('account', 'postId', 'ordinal', 'kind')})
    if status['nextAllowedAt']:
        result['problem'] = {'code': 'waiting', 'message': '저장된 대기 시간이 아직 지나지 않았습니다.'}
    else:
        transport.dependencies(selected['kind'])
    if data['sources'] != runner._source(root)['sources'] or status['signature'] != view.state_signature(root):
        raise StateError('source_changed', '대상을 확인하는 중 원본 또는 상태가 변경되었습니다.')
    view.idle(root)
    return result
