"""Explicit local recovery of an abandoned download lock; never a collector lock."""
import json
import os
from pathlib import Path
import re
import uuid

from .state import StateError, safe_path, durable_json
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
