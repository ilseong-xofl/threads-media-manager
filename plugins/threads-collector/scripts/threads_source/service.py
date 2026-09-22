"""Excel is the only final collection source. SQLite belongs to the local app."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from . import excel_input as excel, workbook_write as writer
from .files import CollectionLock, SourceError, collection_root, file_hash, parse_json, read_stable, safe_path, sync_directory

COMPLETED = excel.COMMITTED - {'partial'}


def _clean(row):
    return {key: value for key, value in row.items() if not key.startswith('_')}


def _load(root):
    try:
        return excel.load_collection(root)
    except excel.InputError as exc:
        raise SourceError(exc.code, str(exc)) from exc


def inspect_source(root: Path) -> dict:
    """Pure read, including attempt dates so partial runs cannot bypass daily limits."""
    data = _load(collection_root(root))
    accounts = {}
    for run in sorted(data['runs'], key=lambda row: (row.get('시작(KST)') or '', row.get('실행ID') or '')):
        if run.get('_blocked') or run['결과'] not in excel.COMMITTED:
            continue
        entry = accounts.setdefault(run['계정명'], {'account': run['계정명'], 'latest_run': None, 'next_anchor': '', 'source': None})
        entry.update(last_attempt=run['시작(KST)'], last_attempt_run=run['실행ID'], last_result=run['결과'])
        if run['결과'] in COMPLETED:
            entry.update(latest_run=run['실행ID'], next_anchor=run['다음기준ID'], source=run['_source'])
    return {'source_files': len(data['sources']), 'posts': len(data['posts']), 'media': len(data['media']),
            'errors': [{k: v for k, v in error.items() if k in {'code', 'sheet', 'row'}} for error in data['errors']],
            'warnings': len(data['warnings']), 'accounts': [accounts[key] for key in sorted(accounts)]}


def _check_existing_run(root, run):
    existing = _load(root)
    if existing['errors']:
        raise SourceError('invalid_source', '기존 Excel 원본에 검증 오류가 있습니다.')
    for previous in existing['runs']:
        if excel._key(previous, 'runs') == excel._key(run, 'runs'):
            if previous['수집일자(KST)'] != run['수집일자(KST)']:
                raise SourceError('run_conflict', '같은 수집 실행이 다른 날짜 원본에 이미 있습니다.')
    return existing


def _input_path(root, value):
    path = Path(value)
    try:
        relative = path.relative_to(root).as_posix() if path.is_absolute() else ''
    except ValueError:
        relative = ''
    if not relative.startswith('_work/') or relative == '_work/collector.lock':
        raise SourceError('invalid_input', '수집 폴더 _work 아래의 절대 입력 경로가 필요합니다.')
    return safe_path(root, relative, require_file=True)


def _account_plan(root, data, account):
    path = safe_path(root, 'accounts.xlsx', require_file=True)
    raw = read_stable(path, max_bytes=excel.MAX_ARCHIVE_BYTES)
    table = excel._read_tables(path, {'계정': excel.ACCOUNT_HEADERS})
    selected = [row for row in table['계정'] if row['계정명'] == account]
    if table['errors'] or len(selected) != 1:
        raise SourceError('invalid_accounts', '계정 파일에 정확히 하나의 유효한 대상 계정이 필요합니다.')
    entry = selected[0]
    runs = sorted([row for row in data['runs'] if row['계정명'] == account and row['결과'] in excel.COMMITTED],
                  key=lambda row: (row['시작(KST)'], row['실행ID']))
    if not runs:
        return None
    latest = runs[-1]
    complete = [row for row in runs if row['결과'] in COMPLETED]
    notes = entry.get('특이사항') or ''
    for run in runs:
        note = run.get('특이사항') or ''
        if note and note not in notes:
            notes += ('\n' if notes else '') + note
    values = {'기준게시글ID': complete[-1]['다음기준ID'] if complete else latest['기존기준ID'],
              '최근 시도(KST)': latest['시작(KST)'], '최근 결과': latest['결과'],
              '최근실행ID': latest['실행ID'], '최근결과파일': latest['_source'], '특이사항': notes}
    if complete:
        values['최근 완료(KST)'] = complete[-1]['종료(KST)']
    if hashlib.sha256(raw).hexdigest() != table['source_sha256']:
        raise SourceError('source_changed', '계정 파일을 읽는 중 변경되었습니다.')
    if all(entry.get(key) == value for key, value in values.items()):
        return None
    return raw, table['source_sha256'], entry['_row'], values


def _digest(checked):
    return hashlib.sha256(json.dumps({kind: [_clean(row) for row in checked[kind]] for kind in ('posts', 'media', 'runs')},
        sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def _daily_plan(root, checked, relative, digest):
    path = safe_path(root, relative)
    writer.unlocked(path)
    before = file_hash(path) if path.exists() else None
    raw = read_stable(path if before else writer.TEMPLATE, max_bytes=excel.MAX_ARCHIVE_BYTES)
    old = excel.read_workbook(path) if before else excel.validate_records([], [], [])
    if old['errors'] or (before and hashlib.sha256(raw).hexdigest() != old['source_sha256']):
        raise SourceError('invalid_source', '기존 Excel 원본이 손상되었거나 읽는 중 변경되었습니다.')
    run = checked['runs'][0]
    previous = next((r for r in old['runs'] if excel._key(r, 'runs') == excel._key(run, 'runs')), None)
    if previous:
        table = excel._read_tables(path, {'실행기록': (*excel.RUN_HEADERS, writer.DIGEST_HEADER)})
        entry = next(r for r in table['실행기록'] if excel._key(r, 'runs') == excel._key(run, 'runs'))
        if table['errors'] or entry[writer.DIGEST_HEADER] != digest or _clean(previous) != _clean(run):
            raise SourceError('run_conflict', '같은 수집 실행에 다른 입력이 있습니다.')
        return None, before
    # Preflight cross-observation conflicts and retain earlier complete fields.
    for source in (old, checked):
        for kind in ('posts', 'media', 'runs'):
            for row in source[kind]:
                row.update(_source=relative, _source_sha256=before or '')
    merged = excel.merge_validated_sources([old, checked])
    if merged['errors']:
        raise SourceError('observation_conflict', '같은 게시글·첨부 관찰이 충돌합니다. 기존 원본을 보존했습니다.')
    updates = {}
    for kind, sheet in (('posts', '게시글'), ('media', '미디어'), ('runs', '실행기록')):
        prior = {excel._key(row, kind): row for row in old[kind]}
        changed_keys = {excel._key(row, kind) for row in checked[kind]}
        changes = []
        for row in merged[kind]:
            key = excel._key(row, kind)
            if key not in changed_keys:
                continue
            values = _clean(row)
            if kind == 'posts':
                observations = [p for p in old['posts'] + checked['posts'] if excel._key(p, 'posts') == key]
                best_caption = max(observations, key=lambda p: ({'complete': 2, 'partial': 1, 'unknown': 0}[p['캡션 상태']], p.get('_caption_time') or p['최근확인시각(KST)']))
                latest = max(observations, key=lambda p: p['최근확인시각(KST)'])
                values['캡션'] = best_caption['캡션']
                values['캡션 상태'] = best_caption['캡션 상태']
                values['캡션원본확인시각(KST)'] = best_caption.get('_caption_time') or best_caption['최근확인시각(KST)']
                values['캡션원본실행ID'] = best_caption.get('_caption_run') or best_caption['확인실행ID']
                values['최근관찰첨부 상태'] = latest.get('_latest_attachment_status') or latest['첨부 상태']
            if kind == 'runs':
                values[writer.DIGEST_HEADER] = digest
            changes.append((prior[key]['_row'] if key in prior else None, values))
        updates[sheet] = changes
    return writer.patch_workbook(raw, updates), before


def commit_source(root: Path, input_path: Path, *, lock_token=None, journal_path=None) -> dict:
    """Workbook first, account marker second, owned temporary records last.

    A retry uses the run digest in Excel and repairs account markers without
    re-collecting. Failure preserves input/journal and all existing workbooks.
    """
    with CollectionLock(root, token=lock_token) as lock:
        path = _input_path(lock.root, input_path)
        input_hash = file_hash(path)
        data = parse_json(read_stable(path, max_bytes=excel.MAX_ARCHIVE_BYTES))
        if not isinstance(data, dict) or set(data) != {'posts', 'media', 'run'} or not isinstance(data['run'], dict):
            raise SourceError('invalid_input', 'posts·media·run 형식의 확정 수집 자료가 필요합니다.')
        checked = excel.validate_records(data['posts'], data['media'], [data['run']])
        if checked['errors'] or len(checked['runs']) != 1:
            raise SourceError('invalid_source', '수집 자료 검증에 실패했습니다.')
        run = checked['runs'][0]
        if run['결과'] == 'running':
            raise SourceError('collection_incomplete', '탐색 중인 실행을 원본으로 확정하지 않습니다.')
        lock.assert_owned(run['실행ID'])
        journal = None
        journal_hash = None
        if journal_path is not None:
            from collection_journal import read_journal, JournalError
            journal = _input_path(lock.root, journal_path)
            if journal == path:
                raise SourceError('invalid_input', '탐색 기록과 정규화 입력은 서로 다른 파일이어야 합니다.')
            journal_hash = file_hash(journal)
            try:
                snapshot = read_journal(journal)
            except JournalError as exc:
                raise SourceError('journal_invalid', '탐색 기록 검증에 실패했습니다. 원본을 보존했습니다.') from exc
            if (snapshot['recovery']['incomplete_tail'] or not snapshot['state']['closed'] or
                    snapshot['state']['run_id'] != run['실행ID'] or snapshot['state']['account'] != run['계정명']):
                raise SourceError('journal_incomplete', '같은 실행·계정의 종료된 탐색 기록이 필요합니다.')
        existing = _check_existing_run(lock.root, run)
        day = run['수집일자(KST)'][:10]
        relative = f'results/{day[:4]}/{day[5:7]}/threads-{day}.xlsx'
        digest = _digest(checked)
        for kind in ('posts', 'media', 'runs'):
            for row in checked[kind]:
                row.update(_source=relative, _source_sha256='')
        content, before = _daily_plan(lock.root, checked, relative, digest)
        if excel.merge_validated_sources([existing, checked])['errors']:
            raise SourceError('observation_conflict', '기존 Excel과 새 관찰이 충돌합니다.')
        def guarded():
            lock.assert_owned(run['실행ID'])
            for source in existing['sources']:
                if source['relative_path'] != relative and file_hash(safe_path(lock.root, source['relative_path'], require_file=True)) != source['sha256']:
                    raise SourceError('source_changed', '저장 중 과거 Excel 원본이 변경되었습니다.')
            if file_hash(path) != input_hash or (journal and file_hash(journal) != journal_hash):
                raise SourceError('source_changed', '저장 도중 임시 입력이 변경되었습니다.')
        # Validate account identity before publishing any workbook.
        _account_plan(lock.root, existing, run['계정명'])
        if content is not None:
            def validate_daily(target):
                verified = excel.read_workbook(target)
                if verified['errors']:
                    raise SourceError('invalid_source', '저장한 Excel의 재열기 검증에 실패했습니다.')
            writer.publish(lock.root, relative, content, before, validate_daily, guarded)
        current = _load(lock.root)
        if current['errors']:
            raise SourceError('invalid_source', '저장 후 원본 검증에 실패했습니다. 임시 기록을 보존했습니다.')
        plan = _account_plan(lock.root, current, run['계정명'])
        if plan:
            raw, accounts_hash, number, values = plan
            updated = writer.patch_workbook(raw, {'계정': [(number, values)]})
            def validate_accounts(target):
                table = excel._read_tables(target, {'계정': excel.ACCOUNT_HEADERS})
                selected = [row for row in table['계정'] if row['계정명'] == run['계정명']]
                if table['errors'] or len(selected) != 1 or any(selected[0].get(k) != v for k, v in values.items()):
                    raise SourceError('invalid_accounts', '계정 상태 반영 검증에 실패했습니다.')
            writer.publish(lock.root, 'accounts.xlsx', updated, accounts_hash, validate_accounts, guarded)
        guarded()
        if _account_plan(lock.root, current, run['계정명']) is not None:
            raise SourceError('source_changed', '검증 중 계정 파일이 변경되었습니다.')
        if _load(lock.root)['sources'] != current['sources']:
            raise SourceError('source_changed', '검증 중 결과 Excel이 변경되었습니다.')
        result = {'relative_path': relative, 'sha256': file_hash(safe_path(lock.root, relative, require_file=True)),
                  'appended': content is not None, 'accounts_verified': True, 'temporary_cleaned': False}
        if journal is not None:
            # No directory recursion: unrelated recovery files are never removed.
            journal.unlink()
            path.unlink()
            sync_directory(journal.parent)
            if path.parent != journal.parent:
                sync_directory(path.parent)
            result['temporary_cleaned'] = True
        return result
