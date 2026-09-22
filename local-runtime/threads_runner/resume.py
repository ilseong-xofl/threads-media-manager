"""User-requested continuation of an existing batch, never a new queue or retry loop."""
import copy
import uuid

from . import attempts, deletion_state, inspection, runner, transport
from .state import POLICY, StateError, safe_path

# Storage integrity and backup-history review are deliberately not
# cleared here. A click is permission to revalidate these known interruption cases.
RESUMABLE_STOPS = {
    'cancelled', 'interrupted', 'parent_exited', 'system_resume', 'timeout', 'clock_rollback',
    'transfer_failed', 'download_failed', 'length_mismatch', 'rate_limited',
    'server_unavailable', 'url_expired', 'signature_rejected', 'access_denied_unknown',
    'url_unavailable', 'source_changed', 'post_deleted', 'invalid_source',
    'source_target_changed', 'source_target_missing', 'source_not_ready',
    'url_recollection_required', 'dependency_missing',
}


def possible(meta):
    plan, stop = meta.get('download_batch'), meta.get('stop')
    return bool(isinstance(plan, dict) and plan.get('version') == 1 and
                plan.get('policy') == POLICY and plan.get('status') in {'active', 'stopped', 'complete'} and
                isinstance(plan.get('targets'), list) and
                (plan.get('status') != 'complete' or stop) and
                (not stop or stop.get('code') in RESUMABLE_STOPS))


def revalidate(state, *, recovered_complete=False):
    """Commit revised references and new attempts atomically after all checks pass."""
    from . import batch
    plan = state.meta(batch.META)
    complete_after_recovery = bool(recovered_complete and isinstance(plan, dict) and
        plan.get('version') == 1 and plan.get('policy') == POLICY and
        plan.get('status') == 'complete' and isinstance(plan.get('targets'), list) and not state.meta('stop'))
    if not complete_after_recovery and not possible({'download_batch': plan, 'stop': state.meta('stop')}):
        raise StateError('resume_review_required', '현재 중단 사유 또는 다운로드 계획을 먼저 확인해야 합니다.')
    if state.clock() < state.meta('last_clock', state.clock()) - 1:
        raise StateError('clock_rollback', '컴퓨터 시각이 이전 실행보다 과거입니다. 시각을 확인하세요.')
    batch._validate_saved(state)
    targets, cursor = plan['targets'], plan.get('nextIndex')
    if type(cursor) is not int or not 0 <= cursor <= len(targets):
        raise StateError('invalid_batch', '저장된 다운로드 진행 위치를 확인해야 합니다.')
    deleted = deletion_state.deleted_posts(state.root, db=state.db)
    current = {row['job_id']: row for row in attempts.current_jobs(state, deleted=set())}
    ids = set()
    for index, target in enumerate(targets):
        required = {'jobId', 'mediaId', 'account', 'postId', 'ordinal', 'kind', 'round',
                    'source', 'sourceHash', 'runId', 'urlHash', 'lastInPost', 'lastInRound', 'lastInAccount'}
        if not isinstance(target, dict) or not required <= target.keys():
            raise StateError('invalid_batch', '저장된 다운로드 대상이 올바르지 않습니다.')
        row = current.get(target['jobId'])
        if (not row or row['job_id'] in ids or row['source_type'] != 'xlsx' or
                (row['account'], row['post_id'], row['ordinal'], row['kind'], row['media_id']) !=
                (target['account'], target['postId'], target['ordinal'], target['kind'], target['mediaId']) or
                (row['source_rel'], row['source_sha256'], row['run_id'], row['url_hash']) !=
                (target['source'], target['sourceHash'], target['runId'], target['urlHash']) or
                row['status'] not in ({'complete'} if index < cursor else {'planned', 'failed', 'interrupted'})):
            raise StateError('invalid_batch', '저장된 계획과 다운로드 시도의 연결이 다릅니다.')
        ids.add(row['job_id'])
    if any(row['job_id'] not in ids and row['status'] != 'complete' and
           (row['account'], row['post_id']) not in deleted for row in current.values()):
        raise StateError('pending_plan_conflict', '기존 회차 밖의 미완료 다운로드를 먼저 확인하세요.')

    remaining = [target for target in targets[cursor:] if (target['account'], target['postId']) not in deleted]
    # Even completed/deleted batches may need only a local stop acknowledgement;
    # they must not adopt new collection posts during this operation.
    data = runner._source(state.root, db=state.db) if remaining else None
    posts = {(post['계정명'], post['게시글ID']): post for post in data['posts']} if data else {}
    media_by_key = {}
    for key in {(item['account'], item['postId']) for item in remaining}:
        post = posts.get(key)
        if post is None:
            raise StateError('source_target_missing', '기존 다운로드 대상이 수집 원본에서 사라졌습니다. 원본 또는 앱 삭제 기록을 확인하세요.')
        media = runner._eligible_post(data, post, saved=lambda item: any(
            row['status'] == 'complete' and (row['account'], row['post_id'], row['ordinal']) ==
            (item['계정명'], item['게시글ID'], item['순서']) for row in current.values()))
        known = {(row['ordinal'], row['kind']) for row in state.db.execute(
            'SELECT ordinal,kind FROM media WHERE account=? AND post_id=?', key)}
        if not media:
            raise StateError('source_not_ready', '기존 게시글의 수집 상태 또는 첨부 주소를 다시 확인해야 합니다.')
        if {(item['순서'], item['종류']) for item in media} != known:
            raise StateError('source_target_changed', '기존 게시글의 첨부 수·순서·종류가 달라져 이어받기를 중단했습니다.')
        media_by_key[key] = {item['순서']: item for item in media}

    replacements = []
    revised = copy.deepcopy(plan)
    revised['targets'] = []
    revised['nextIndex'] = sum((target['account'], target['postId']) not in deleted for target in targets[:cursor])
    for index, original in enumerate(targets):
        key = original['account'], original['postId']
        if key in deleted:
            continue
        target = copy.deepcopy(original)
        row = current[target['jobId']]
        if index >= cursor:
            item = media_by_key[key][target['ordinal']]
            transport.validate_url(item['다운로드URL'])
            fresh = inspection.candidate(posts[key], item)
            if state.db.execute('SELECT 1 FROM requests WHERE url_hash=? AND http_status IN (401,403) LIMIT 1',
                                (fresh['urlHash'],)).fetchone():
                raise StateError('url_recollection_required', '접근이 거절된 동일 주소는 다시 요청하지 않습니다. 새로 수집한 주소가 필요합니다.')
            transport.dependencies(target['kind'])
            target.update(fresh)
            changed = any(target[name] != original[name] for name in ('source', 'sourceHash', 'runId', 'urlHash'))
            if row['status'] != 'planned' or changed:
                # Validate the old destination without touching or reusing its bytes.
                old_part = safe_path(state.root, row['part_rel'])
                if old_part.exists():
                    safe_path(state.root, row['part_rel'], require_file=True)
                target['jobId'] = uuid.uuid4().hex
                replacements.append((row, target, 'source_revalidated' if changed else 'explicit_resume'))
        revised['targets'].append(target)

    # Keep original whole-post round membership. Deletion may shorten a round;
    # it never fills it using newly collected posts or moves a survivor to another.
    rounds = {number: index + 1 for index, number in enumerate(sorted({t['round'] for t in revised['targets']}))}
    for index, target in enumerate(revised['targets']):
        target['round'] = rounds[target['round']]
    for index, target in enumerate(revised['targets']):
        after = revised['targets'][index + 1] if index + 1 < len(revised['targets']) else None
        target['lastInPost'] = after is None or (after['account'], after['postId']) != (target['account'], target['postId'])
        target['lastInRound'] = after is None or after['round'] != target['round']
        target['lastInAccount'] = after is None or after['account'] != target['account']
    revised['totalPosts'] = len({(t['account'], t['postId']) for t in revised['targets']})
    revised['totalRounds'] = len(rounds)
    revised['deferred'] = [item for item in revised['deferred'] if (item['account'], item['postId']) not in deleted]
    revised['status'] = 'complete' if revised['nextIndex'] == len(revised['targets']) else 'active'
    if data:
        revised['sources'] = data['sources']
        batch._source_guard(state, revised)
    with state.db:
        for previous, target, reason in replacements:
            state.db.execute('''INSERT INTO jobs(job_id,media_id,source_rel,source_sha256,source_type,
                run_id,url_hash,status,part_rel,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)''',
                (target['jobId'], target['mediaId'], target['source'], target['sourceHash'], 'xlsx',
                 target['runId'], target['urlHash'], 'planned', f"media/.partial/{target['jobId']}.part", state.clock(), state.clock()))
            attempts.link(state, previous['job_id'], target['jobId'], reason)
        history = state.meta('download_batch_history', [])
        history.append({'plan': plan, 'stop': state.meta('stop'), 'continuedAt': state.clock()})
        state.set_meta('download_batch_history', history)
        state.set_meta(batch.META, revised)
        state.set_meta('stop', None)
        state.set_meta('last_clock', max(state.clock(), state.meta('last_clock', state.clock())))
        # If deletion moved a finished round boundary behind the cursor, preserve
        # all prior deadlines and sample this newly reached boundary just once.
        if revised['nextIndex'] and revised['nextIndex'] < len(revised['targets']):
            previous = revised['targets'][revised['nextIndex'] - 1]
            if previous['lastInRound'] and plan.get('boundary', {}).get('jobId') != previous['jobId']:
                waits = {'roundWaitSeconds': batch._sample('round_wait_seconds')}
                if previous['lastInAccount']:
                    waits['accountWaitSeconds'] = batch._sample('account_wait_seconds')
                deadline = max(state.meta('next_allowed', 0), *(state.clock() + delay for delay in waits.values()))
                state.set_meta('next_allowed', deadline)
                revised['boundary'] = {'jobId': previous['jobId'], 'completedAt': state.clock(), 'nextAllowedAt': deadline, **waits}
                state.set_meta(batch.META, revised)
    return revised
