#!/usr/bin/env python3
"""Private Electron worker: one input, bounded events, cooperative stdin cancel."""
import argparse
import json
import os
from pathlib import Path
import signal
import sys
import threading
import time

# -I does not put the script directory on sys.path.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from threads_runner import inspection, runner, transport, recovery, batch
from threads_runner.state import StateError
from threads_runner.parent_monitor import ParentMonitor, MonitorError


def emit(value):
    print(json.dumps(value, ensure_ascii=False, allow_nan=False), flush=True)


def request():
    raw = bytearray()
    while len(raw) < 16384:
        char = os.read(0, 1)
        if not char:
            raise StateError('parent_exited', '앱 연결이 닫혔습니다.')
        if char == b'\n':
            data = json.loads(raw)
            if not isinstance(data, dict):
                break
            return data
        raw.extend(char)
    raise StateError('invalid_request', '다운로드 요청 형식이 올바르지 않습니다.')


def watch_input(stopped):
    # Raw descriptor reads avoid a daemon BufferedReader lock during shutdown.
    try:
        while True:
            data = os.read(0, 4096)
            if not data or data.strip():
                stopped.set()
                return
    except OSError:
        stopped.set()


def execute(root, data, cancel, *, transfer=None, output=emit):
    command = data.get('command')
    if command == 'status':
        if set(data) != {'command'}:
            raise StateError('invalid_request', '상태 조회는 별도 입력을 받지 않습니다.')
        return recovery.read_status(root)
    if command in {'resume', 'continue'}:
        if set(data) != {'command'}:
            raise StateError('invalid_request', '기존 다운로드 대상만 이어서 처리할 수 있습니다.')
        return batch.run(root, cancel, transfer=transfer, output=output, resume_requested=True)
    if command == 'batch':
        if set(data) != {'command'}:
            raise StateError('invalid_request', '전체 다운로드는 앱에서 현재 원본으로 계획합니다.')
        return batch.run(root, cancel, transfer=transfer, output=output)
    if command == 'preview':
        return inspection.preview_one(root, data.get('account'))
    if command == 'recover':
        if cancel():
            raise StateError('cancelled', '복구를 중지했습니다.')
        output({'type': 'progress', 'phase': 'recovering', 'received': 0, 'total': None})
        recovery.release_abandoned(root)
        result = runner.recover(root)
        return {'recovered': len(result['recovered']), **inspection.public_status(inspection.read_status(root))}
    if command != 'download' or not isinstance(data.get('plan'), dict):
        raise StateError('invalid_request', '지원하지 않는 다운로드 요청입니다.')
    plan = data['plan']
    fresh = inspection.preview_one(root, plan.get('account'))
    if fresh['problem']:
        raise StateError(fresh['problem']['code'], fresh['problem']['message'])
    if fresh['plan'] != plan:
        raise StateError('source_changed', '확인한 원본 또는 대상이 바뀌었습니다. 다시 확인하세요.')
    if cancel():
        raise StateError('cancelled', '사용자 중지로 전송하지 않았습니다.')
    job = runner.plan_one(root, plan['account'], expected=plan)
    last = [0, '']
    def progress(phase, received, total):
        now = time.monotonic()
        if phase != last[1] or now-last[0] >= .15 or received == total:
            output({'type': 'progress', 'phase': phase, 'received': received, 'total': total})
            last[:] = [now, phase]
    def download(*args, **kwargs):
        progress('downloading', 0, None)
        return (transfer or transport.download)(*args, **kwargs, progress=progress)
    result = runner.download_one(root, job['job_id'], cancel=cancel, download=download)
    return {'jobId': result['job_id'], 'status': result['status'], 'size': result.get('size'),
            **inspection.public_status(inspection.read_status(root))}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--collection-root', type=Path, required=True)
    args = parser.parse_args()
    stopped = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stopped.set())
    monitor = None
    try:
        monitor = ParentMonitor()
        data = request()
        threading.Thread(target=watch_input, args=(stopped,), daemon=True).start()
        result = execute(args.collection_root, data, lambda: stopped.is_set() or monitor.cancelled())
        emit({'type': 'result', 'ok': True, 'result': result})
        return 0
    except Exception as exc:
        safe = isinstance(exc, (StateError, transport.TransferError, MonitorError)) or type(exc).__name__ in {'SourceError', 'InputError'}
        emit({'type': 'result', 'ok': False, 'error': {'code': getattr(exc, 'code', 'download_error') if safe else 'download_error',
              'message': str(exc) if safe else '다운로드 처리를 중단했습니다. 기존 파일과 상태를 보존했습니다.'}})
        return 1
    finally:
        if monitor:
            monitor.close()


if __name__ == '__main__':
    sys.exit(main())
