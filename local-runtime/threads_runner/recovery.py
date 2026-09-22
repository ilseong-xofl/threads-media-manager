"""Explicit local recovery of an abandoned download lock; never a collector lock."""
import json
import os
from pathlib import Path
import re
import uuid
import shutil
import sqlite3
import tempfile
import time
from contextlib import closing

from .state import APP_ID, SCHEMA_VERSION, StateError, safe_path, durable_json, supported_policy
from .deletion_state import require_no_pending


def definitely_dead(pid):
    if type(pid) is not int or pid <= 1:
        return False
    if os.name == 'nt':
        from .parent_monitor import _windows_kernel
        kernel = _windows_kernel()
        handle = kernel.open_process(pid)
        if not handle:
            return kernel.ctypes.get_last_error() == 87  # ERROR_INVALID_PARAMETER: no process.
        try:
            return kernel.wait(handle) == 0  # A signaled process has exited.
        finally:
            kernel.close(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    except OSError:
        return False
    return False


def _lock_snapshot(root):
    lock = safe_path(root, '_work/collector.lock')
    if not lock.exists():
        return None
    safe_path(root, '_work/collector.lock', require_file=True)
    if lock.stat().st_size > 4096:
        raise StateError('busy', '잠금 소유자를 확인할 수 없습니다.')
    raw = lock.read_bytes()
    try:
        value = json.loads(raw)
    except (ValueError, UnicodeError):
        value = None
    if (not isinstance(value, dict) or value.get('owner') != 'download-runner' or
            not re.fullmatch(r'[a-f0-9]{32}', str(value.get('token', ''))) or
            not definitely_dead(value.get('pid'))):
        raise StateError('busy', '활성 작업 또는 수집 잠금이 있습니다. 종료 후 다시 확인하세요.')
    return raw


def read_status(root, *, clock=time.time):
    """Read crash-persisted WAL through a disposable copy; original bytes never change.

    SQLite may recover/checkpoint the copy, never the library. Both the source file
    stamps and dead-lock identity are rechecked before exposing the copied state.
    """
    import collection_view as view
    from . import attempts, deletion_state, inspection, resume
    root = view.collection_root(Path(root))
    require_no_pending(root)
    lock = _lock_snapshot(root)
    relatives = ('state/state.db', 'state/state.db-wal', 'state/state.db-shm',
                 'state/state.db-journal', 'media/.library.json')
    def stamps():
        result = {}
        for relative in relatives:
            path = safe_path(root, relative)
            result[relative] = view.stamp(safe_path(root, relative, require_file=True)) if path.exists() else None
        return result
    before = stamps()
    if before['state/state.db'] is None:
        media = safe_path(root, 'media')
        state_dir = safe_path(root, 'state')
        if ((media.exists() and any(media.iterdir())) or
                (state_dir.exists() and any(state_dir.iterdir())) or lock is not None):
            raise StateError('library_recovery_required', '기존 자료와 연결된 상태 DB가 필요합니다.')
        return {'nextAllowedAt': None, 'problem': None, 'recoverable': False, 'resumable': False}
    marker_path = safe_path(root, 'media/.library.json', require_file=True)
    if marker_path.stat().st_size > 4096:
        raise StateError('library_mismatch', '미디어 식별 파일을 확인해야 합니다.')
    try:
        marker = json.loads(marker_path.read_bytes())
        with tempfile.TemporaryDirectory(prefix='tmm-status-') as directory:
            temporary = Path(directory)
            for relative in relatives[:-1]:
                if before[relative] is not None:
                    shutil.copyfile(safe_path(root, relative, require_file=True), temporary / Path(relative).name)
            if before != stamps() or lock != _lock_snapshot(root):
                raise StateError('state_changed', '조회 중 다운로드 상태가 변경되었습니다.')
            with closing(sqlite3.connect(temporary / 'state.db', timeout=0)) as db:
                db.row_factory = sqlite3.Row
                db.execute('PRAGMA trusted_schema=OFF')
                if (db.execute('PRAGMA application_id').fetchone()[0] != APP_ID or
                        db.execute('PRAGMA user_version').fetchone()[0] != SCHEMA_VERSION or
                        db.execute('PRAGMA quick_check').fetchone()[0] != 'ok'):
                    raise StateError('invalid_database', '지원하지 않거나 손상된 상태 DB입니다.')
                meta = {row['key']: json.loads(row['value']) for row in db.execute('SELECT * FROM meta')}
                if (not isinstance(marker, dict) or marker.get('schema_version') != 1 or
                        not re.fullmatch(r'[a-f0-9]{32}', str(meta.get('library_id', ''))) or
                        marker.get('library_id') != meta.get('library_id')):
                    raise StateError('library_mismatch', 'DB와 미디어 폴더의 연결이 다릅니다.')
                if meta.get('root') != str(root):
                    raise StateError('root_changed', '라이브러리의 폴더 재연결이 필요합니다.')
                if not supported_policy(meta.get('policy')):
                    raise StateError('policy_mismatch', '저장된 다운로드 정책을 확인해야 합니다.')
                retired = attempts.retired_ids(db)
                deleted = deletion_state.database_deletions(root, db)[0] | deletion_state.excel_deletions(root)
                jobs = [dict(row) for row in db.execute('SELECT j.*,m.account,m.post_id FROM jobs j JOIN media m USING(media_id)')
                        if row['job_id'] not in retired and (row['account'], row['post_id']) not in deleted]
        if before != stamps() or lock != _lock_snapshot(root):
            raise StateError('state_changed', '조회 중 다운로드 상태가 변경되었습니다.')
    except (sqlite3.Error, ValueError, OSError) as exc:
        if isinstance(exc, StateError):
            raise
        raise StateError('invalid_database', '상태 DB 조회에 실패했습니다. 기존 파일은 변경하지 않았습니다.') from None
    pending_storage = any(before[relative] and before[relative][2] for relative in relatives if relative.endswith(('-wal', '-journal')))
    recoverable = bool(lock is not None or pending_storage or any(job['status'] in {'running', 'staged'} for job in jobs))
    now, problem = clock(), None
    if meta.get('stop'):
        message = ('이전 다운로드가 중단되었습니다. 상태를 확인한 뒤 명시적으로 이어서 다운로드하세요.'
                   if resume.possible(meta) else '이전 다운로드 중단 사유를 확인해야 합니다. 요청 이력과 기존 파일은 보존했습니다.')
        problem = {'code': meta['stop']['code'], 'message': message}
    elif now < meta.get('last_clock', now) - 1:
        problem = {'code': 'clock_rollback', 'message': '컴퓨터 시각이 이전 실행보다 과거입니다. 시각을 확인하세요.'}
    elif recoverable or any(job['status'] in {'failed', 'interrupted'} for job in jobs):
        problem = {'code': 'recovery_required', 'message': '완료되지 않은 다운로드가 있습니다. 저장 상태를 확인한 뒤 이어서 진행하세요.'}
    value = inspection.public_status({'nextAllowedAt': meta.get('next_allowed') if meta.get('next_allowed', 0) > now else None,
        'recoverable': recoverable, 'problem': problem, 'meta': meta})
    if now < meta.get('last_clock', now) - 1:
        value['resumable'] = False
    return value


def release_abandoned(root):
    import collection_view as view
    root = view.collection_root(Path(root))
    require_no_pending(root)
    safe_path(root, 'state/state.db', require_file=True)
    lock = safe_path(root, '_work/collector.lock')
    if not lock.exists():
        return
    guard = safe_path(root, '_work/download-recovery.lock')
    token = uuid.uuid4().hex
    try:
        durable_json(guard, {'token': token})
    except FileExistsError:
        raise StateError('busy', '다른 복구 작업이 진행 중이거나 확인이 필요합니다.') from None
    try:
        safe_path(root, '_work/collector.lock', require_file=True)
        before = lock.stat()
        if before.st_size > 4096:
            raise ValueError()
        raw = lock.read_bytes()
        data = json.loads(raw)
        if (not isinstance(data, dict) or data.get('owner') != 'download-runner' or
                not re.fullmatch(r'[a-f0-9]{32}', str(data.get('token', ''))) or
                not definitely_dead(data.get('pid'))):
            raise StateError('busy', '활성 작업 또는 수집 잠금은 해제하지 않습니다. 해당 작업을 먼저 종료하세요.')
        # Serialize recovery attempts and verify the original lock again before removal.
        after = lock.stat()
        if ((before.st_dev, before.st_ino, before.st_mtime_ns, before.st_size) !=
                (after.st_dev, after.st_ino, after.st_mtime_ns, after.st_size) or lock.read_bytes() != raw):
            raise StateError('busy', '잠금이 변경되어 복구를 중단했습니다.')
        lock.unlink()
    except (ValueError, OSError) as exc:
        if isinstance(exc, StateError):
            raise
        raise StateError('busy', '다운로드 잠금의 소유자를 확인할 수 없어 보존했습니다.') from None
    finally:
        if not guard.is_symlink() and json.loads(guard.read_text()).get('token') == token:
            guard.unlink()
