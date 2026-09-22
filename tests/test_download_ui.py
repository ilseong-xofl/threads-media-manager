"""App worker integration with synthetic Excel and offline transfer only."""
import hashlib
import io
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / 'local-runtime'
sys.path.insert(0, str(SCRIPTS))
import collection_view
import download_ui
from threads_runner import inspection, runner, recovery, transport
from threads_runner.state import State, StateError, POLICY, LEGACY_POLICY
from test_download_excel import samples, make_book


class DownloadUITests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        self.book = self.root / 'results/2026/09/threads-2026-09-21.xlsx'
        self.data = samples(account='example')
        self.data['실행기록'][0]['특이사항'] = ''
        self.data['미디어'][0]['다운로드URL'] = 'https://scontent-test.cdninstagram.com/image.jpg?sig=TEST_ONLY'
        self.data['게시글'][0]['이미지 수'] = 2
        self.data['미디어'].append({**self.data['미디어'][0], '순서': 2})
        make_book(self.book, self.data)
        self.source = self.book.read_bytes()
        self.requests, self.events = [], []

    def tearDown(self):
        self.tmp.cleanup()

    def preview(self):
        return download_ui.execute(self.root, {'command': 'preview', 'account': 'example'}, lambda: False)

    def fake(self, url, dest, kind, *, before_request, progress, **kwargs):
        from PIL import Image
        before_request(url, 0)
        self.requests.append(url)
        body = io.BytesIO()
        Image.new('RGB', (2, 3), '#336699').save(body, format='JPEG')
        value = body.getvalue()
        dest.write_bytes(value)
        progress('downloading', len(value), len(value))
        progress('validating', len(value), len(value))
        return {'size': len(value), 'sha256': hashlib.sha256(value).hexdigest(),
                'extension': 'jpg', 'width': 2, 'height': 3, 'content_type': 'image/jpeg'}

    def run_download(self, plan=None, transfer=None, cancel=lambda: False):
        plan = plan or self.preview()['plan']
        return download_ui.execute(self.root, {'command': 'download', 'plan': plan}, cancel,
                                   transfer=transfer or self.fake, output=self.events.append)

    def test_preview_no_state_creation_no_dns_or_network(self):
        with patch('socket.getaddrinfo', side_effect=AssertionError('DNS forbidden')):
            value = self.preview()
        self.assertEqual(value['target']['ordinal'], 1)
        self.assertIsNone(value['nextAllowedAt'])
        self.assertFalse((self.root / 'state').exists())
        self.assertFalse((self.root / 'media').exists())
        self.assertFalse((self.root / '_work').exists())
        self.assertNotIn('TEST_ONLY', json.dumps(value))
        self.assertEqual(self.book.read_bytes(), self.source)

    def test_success_updates_local_view_and_second_download_has_no_daily_cap(self):
        result = self.run_download()
        self.assertEqual(result['status'], 'complete')
        self.assertIsNotNone(result['nextAllowedAt'])
        value = collection_view.read_snapshot(self.root)
        # View must expose the saved UUID URL without any remote media URL.
        self.assertEqual(len(value['files']), 1)
        self.assertEqual(value['snapshot']['posts'][0]['attachments'][0]['status'], 'saved')
        next_file = self.preview()
        self.assertEqual(next_file['target']['ordinal'], 2)
        self.assertEqual(next_file['problem']['code'], 'waiting')
        before = (self.root / 'state/state.db').read_bytes()
        with self.assertRaises(StateError):
            self.run_download(next_file['plan'])
        self.assertEqual((self.root / 'state/state.db').read_bytes(), before)
        self.assertEqual(len(self.requests), 1)
        later = result['nextAllowedAt'] + 1
        original_read = inspection.read_status
        with patch.object(runner, 'State', side_effect=lambda root: State(root, clock=lambda: later)), \
                patch.object(inspection, 'read_status', side_effect=lambda root, **kwargs: original_read(root, clock=lambda: later)):
            second = self.run_download(next_file['plan'])
        self.assertEqual(second['status'], 'complete')
        self.assertEqual(len(self.requests), 2)
        self.assertEqual(self.book.read_bytes(), self.source)
        self.assertTrue(any(e['phase'] == 'validating' for e in self.events))
        with sqlite3.connect(self.root / 'state/state.db') as db:
            self.assertNotIn('TEST_ONLY', '\n'.join(db.iterdump()))
            self.assertEqual(db.execute('SELECT count(*) FROM requests').fetchone()[0], 2)
            self.assertEqual(db.execute("SELECT count(*) FROM jobs WHERE status='complete'").fetchone()[0], 2)

    def test_source_changed_after_preview_is_rejected_before_state_or_request(self):
        plan = self.preview()['plan']
        self.data['게시글'][0]['캡션'] = 'Edited'
        make_book(self.book, self.data)
        with self.assertRaises(StateError) as failure:
            self.run_download(plan)
        self.assertEqual(failure.exception.code, 'source_changed')
        self.assertEqual(self.requests, [])
        self.assertFalse((self.root / 'state').exists())

    def test_immediate_cancel_does_not_create_a_job(self):
        with self.assertRaises(StateError) as failure:
            self.run_download(cancel=lambda: True)
        self.assertEqual(failure.exception.code, 'cancelled')
        self.assertFalse((self.root / 'state').exists())

    def test_first_error_persists_stop_and_never_retries(self):
        def fail(url, dest, kind, *, before_request, **kwargs):
            before_request(url, 0)
            self.requests.append(url)
            raise transport.TransferError('rate_limited', 'Stopped', status=429)
        with self.assertRaises(transport.TransferError):
            self.run_download(transfer=fail)
        self.assertEqual(self.preview()['problem']['code'], 'stopped')
        download_ui.execute(self.root, {'command': 'recover'}, lambda: False, output=self.events.append)
        self.assertEqual(self.preview()['problem']['code'], 'stopped')
        self.assertEqual(len(self.requests), 1)

    def test_cancel_in_transfer_preserves_consumption_and_partial_file(self):
        stopped = [False]
        def interrupt(url, dest, kind, **kwargs):
            value = self.fake(url, dest, kind, **kwargs)
            stopped[0] = True
            return value
        with self.assertRaises(StateError) as failure:
            self.run_download(transfer=interrupt, cancel=lambda: stopped[0])
        self.assertEqual(failure.exception.code, 'cancelled')
        self.assertEqual(runner.status(self.root)['requests_24h'], 1)
        self.assertEqual(len(list((self.root / 'media/.partial').glob('*.part'))), 1)
        self.assertEqual(self.preview()['problem']['code'], 'stopped')

    def test_staged_recovery_finishes_locally_and_retains_stop(self):
        with patch.object(runner, '_publish', side_effect=OSError('Disk failure')):
            with self.assertRaises(OSError):
                self.run_download()
        self.assertTrue(self.preview()['recoverable'])
        result = download_ui.execute(self.root, {'command': 'recover'}, lambda: False, output=self.events.append)
        self.assertEqual(result['recovered'], 1)
        self.assertEqual(result['problem']['code'], 'stopped')
        self.assertFalse(result['recoverable'])
        self.assertEqual(len(self.requests), 1)

    def test_legacy_completed_job_still_skipped_without_migration(self):
        self.run_download()
        with State(self.root) as state:
            with state.db:
                state.db.execute("UPDATE jobs SET source_type='jsonl',source_rel='old.jsonl'")
        self.assertEqual(self.preview()['target']['ordinal'], 2)
        with sqlite3.connect(self.root / 'state/state.db') as db:
            self.assertEqual(db.execute('SELECT source_type FROM jobs').fetchone()[0], 'jsonl')

    def test_process_protocol_returns_safe_json_and_no_db(self):
        result = subprocess.run([sys.executable, '-I', '-B', str(SCRIPTS / 'download_ui.py'),
                                 '--collection-root', str(self.root)],
                                input=json.dumps({'command': 'preview', 'account': 'example'})+'\n',
                                text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertTrue(payload['ok'])
        self.assertNotIn('TEST_ONLY', result.stdout + result.stderr)
        self.assertFalse((self.root / 'state').exists())

    def test_dead_download_lock_recovered_but_collector_and_live_lock_preserved(self):
        runner.plan_one(self.root, 'example')
        lock = self.root / '_work/collector.lock'
        for owner, pid in [('collector', 999999), ('download-runner', os.getpid())]:
            raw = json.dumps({'owner': owner, 'pid': pid, 'token': 'a'*32})
            lock.write_text(raw)
            with self.assertRaises(StateError):
                recovery.release_abandoned(self.root)
            self.assertEqual(lock.read_text(), raw)
            lock.unlink()
        lock.write_text(json.dumps({'owner': 'download-runner', 'pid': 999999, 'token': 'b'*32}))
        with patch.object(recovery, 'definitely_dead', return_value=True):
            recovery.release_abandoned(self.root)
        self.assertFalse(lock.exists())
        self.assertFalse((self.root / '_work/download-recovery.lock').exists())

    def test_stored_wait_expires_without_using_request_age(self):
        self.run_download()
        with State(self.root) as state:
            deadline = state.meta('next_allowed')
        self.assertEqual(inspection.preview_one(self.root, 'example', clock=lambda: deadline-1)['problem']['code'], 'waiting')
        ready = inspection.preview_one(self.root, 'example', clock=lambda: deadline+1)
        self.assertIsNone(ready['problem'])
        self.assertIsNone(ready['nextAllowedAt'])
        self.assertEqual(ready['target']['ordinal'], 2)

    def test_crashed_worker_wal_and_owned_lock_recover_without_retry(self):
        code = '''
import os, sys
from pathlib import Path
sys.path.insert(0, sys.argv[2])
from threads_runner import runner
from threads_runner.state import State
root = Path(sys.argv[1])
job = runner.plan_one(root, 'example')['job_id']
with State(root) as state:
    with state.db:
        state.db.execute("UPDATE jobs SET status='running' WHERE job_id=?", (job,))
    state.reserve_request(job, 'a'*64, 'scontent-test.cdninstagram.com', 0)
    os._exit(7)
'''
        child = subprocess.run([sys.executable, '-I', '-B', '-c', code, str(self.root), str(SCRIPTS)],
                               capture_output=True, text=True, timeout=10)
        self.assertEqual(child.returncode, 7, child.stderr)
        lock = self.root / '_work/collector.lock'
        self.assertTrue(lock.exists())
        self.assertGreater((self.root / 'state/state.db-wal').stat().st_size, 0)
        with patch.object(transport, 'download', side_effect=AssertionError('No retry')):
            result = download_ui.execute(self.root, {'command': 'recover'}, lambda: False, output=self.events.append)
        self.assertFalse(lock.exists())
        self.assertEqual(runner.status(self.root)['requests_24h'], 1)
        self.assertEqual(result['problem']['code'], 'stopped')
        with sqlite3.connect(self.root / 'state/state.db') as db:
            self.assertEqual(db.execute('SELECT status FROM jobs').fetchone()[0], 'interrupted')

    def test_legacy_policy_migration_preserves_history_waits_stops_and_ids(self):
        self.run_download()
        with State(self.root) as state:
            with state.db:
                state.set_meta('policy', LEGACY_POLICY)
                state.set_meta('custom_metadata', {'preserve': True})
            state.stop('rate_limited', retry_at=9999999999, requires_review=True)
            tables = {name: [dict(row) for row in state.db.execute('SELECT * FROM '+name)]
                      for name in ('requests', 'jobs', 'media')}
            original_meta = {row['key']: json.loads(row['value']) for row in state.db.execute('SELECT * FROM meta')}
        before = (self.root / 'state/state.db').read_bytes()
        self.assertEqual(self.preview()['problem']['code'], 'stopped')
        self.assertEqual((self.root / 'state/state.db').read_bytes(), before)
        with State(self.root) as state:
            self.assertEqual(state.meta('policy'), POLICY)
            self.assertNotIn('requests_per_24h', POLICY)
            for name, rows in tables.items():
                self.assertEqual([dict(row) for row in state.db.execute('SELECT * FROM '+name)], rows)
            for key, value in original_meta.items():
                if key != 'policy':
                    self.assertEqual(state.meta(key), value)
            migration = state.meta('policy_migration')
            self.assertEqual(migration['from'], LEGACY_POLICY)
        with State(self.root) as state:
            self.assertEqual(state.meta('policy_migration'), migration)
            with self.assertRaises(StateError) as error:
                state.guard()
            self.assertEqual(error.exception.code, 'stopped')
        self.assertEqual(len(self.requests), 1)

    def test_unknown_policy_is_preserved_and_requires_review(self):
        unknown = {**LEGACY_POLICY, 'name': 'unrecognized-policy'}
        with State(self.root) as state:
            with state.db:
                state.set_meta('policy', unknown)
        with self.assertRaises(StateError) as error:
            self.preview()
        self.assertEqual(error.exception.code, 'policy_mismatch')
        with self.assertRaises(StateError):
            with State(self.root):
                pass
        with sqlite3.connect(self.root / 'state/state.db') as db:
            self.assertEqual(json.loads(db.execute("SELECT value FROM meta WHERE key='policy'").fetchone()[0]), unknown)

    def test_policy_migration_rolls_back_if_history_cannot_be_saved(self):
        with State(self.root) as state:
            with state.db:
                state.set_meta('policy', LEGACY_POLICY)
        original = State.set_meta
        def fail(state, key, value):
            if key == 'policy_migration':
                raise OSError('Storage failure')
            original(state, key, value)
        with patch.object(State, 'set_meta', fail), self.assertRaises(StateError):
            with State(self.root):
                pass
        with sqlite3.connect(self.root / 'state/state.db') as db:
            self.assertEqual(json.loads(db.execute("SELECT value FROM meta WHERE key='policy'").fetchone()[0]), LEGACY_POLICY)
            self.assertIsNone(db.execute("SELECT value FROM meta WHERE key='policy_migration'").fetchone())


if __name__ == '__main__':
    unittest.main()
