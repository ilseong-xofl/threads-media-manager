"""Explicit recovery integration: synthetic libraries, fake GETs and virtual time."""
import copy
import hashlib
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import unittest
from unittest.mock import patch

import test_batch_download as fixtures
from test_download_excel import samples, make_book
import collection_view
import delete_media
import download_ui
from threads_runner import attempts, batch, inspection, recovery, runner, transport
from threads_runner.state import State, StateError

SCRIPTS = Path(__file__).resolve().parents[1] / 'local-runtime'


class DownloadResumeTests(unittest.TestCase):
    setUp, tearDown = fixtures.BatchDownloadTests.setUp, fixtures.BatchDownloadTests.tearDown
    fixture, fake, run_batch, meta, hashes = fixtures.BatchDownloadTests.fixture, fixtures.BatchDownloadTests.fake, fixtures.BatchDownloadTests.run_batch, fixtures.BatchDownloadTests.meta, fixtures.BatchDownloadTests.hashes

    def fail(self, code='timeout', status=None, retry_at=None):
        def transfer(url, dest, kind, **kwargs):
            kwargs['before_request'](url, 0)
            self.requests.append({'url': url, 'time': self.clock()})
            dest.write_bytes(b'preserve incomplete bytes')
            raise transport.TransferError(code, 'Synthetic interrupted transfer', status=status, retry_at=retry_at)
        return transfer

    def rows(self, table):
        with sqlite3.connect(self.root / 'state/state.db') as db:
            db.row_factory = sqlite3.Row
            return [dict(row) for row in db.execute('SELECT * FROM ' + table)]

    def planned(self):
        with patch.object(transport, 'dependencies'), State(self.root, clock=self.clock) as state:
            return batch._persist_plan(state)

    def test_explicit_retry_preserves_attempt_partial_requests_and_media_identity(self):
        self.fixture([('alpha', [2])])
        self.run_batch(transfer=self.fail())
        previous = self.rows('jobs')[0]
        requests = self.rows('requests')
        partial = self.root / previous['part_rel']
        before = partial.read_bytes()
        result = self.run_batch(resume_requested=True)
        self.assertIsNone(result['problem'])
        self.assertEqual(result['batch']['completedFiles'], 2)
        self.assertEqual(partial.read_bytes(), before)
        self.assertIn(previous, self.rows('jobs'))
        self.assertEqual(self.rows('requests')[:1], requests)
        link = self.rows('job_attempts')[0]
        self.assertEqual(link['previous_job_id'], previous['job_id'])
        replacement = next(row for row in self.rows('jobs') if row['job_id'] == link['replacement_job_id'])
        self.assertEqual(replacement['media_id'], previous['media_id'])
        self.assertNotEqual(replacement['part_rel'], previous['part_rel'])
        self.assertEqual(len(self.requests), 3)
        self.assertEqual(self.meta('download_batch_history')[0]['stop']['code'], 'timeout')
        self.assertEqual(self.meta('stop_history')[0]['stop']['code'], 'timeout')
        self.assertIsNone(self.meta('stop'))
        links, _, _, _ = collection_view.read_state(self.root)
        self.assertTrue(all(item['status'] == 'saved' for item in links.values()))
        self.assertIsNone(self.run_batch()['problem'])  # Historical failure is no longer current.
        self.assertEqual(len(self.requests), 3)

    def test_waiting_shutdown_resume_preserves_deadline_and_completed_bytes(self):
        self.fixture([('alpha', [2])])
        stopped = [False]
        result = self.run_batch(cancel=lambda: stopped[0], output=lambda event: stopped.__setitem__(0, event['phase'] == 'waiting'))
        self.assertEqual(result['batch']['completedFiles'], 1)
        deadline = self.meta('next_allowed')
        saved = {path: path.read_bytes() for path in (self.root / 'media/files').rglob('*.jpg')}
        previous = self.rows('jobs')
        self.run_batch(resume_requested=True)
        self.assertEqual(len(self.requests), 2)
        self.assertGreaterEqual(self.requests[1]['time'], deadline)
        self.assertEqual({path: path.read_bytes() for path in saved}, saved)
        self.assertEqual({row['job_id'] for row in previous}, {row['job_id'] for row in self.rows('jobs')})

    def test_retry_after_is_not_shortened_and_http_history_survives(self):
        self.fixture([('alpha', [1])])
        deadline = self.clock() + 300
        self.run_batch(transfer=self.fail('rate_limited', 429, deadline))
        first = self.rows('requests')[0]
        self.run_batch(resume_requested=True)
        self.assertGreaterEqual(self.requests[1]['time'], deadline)
        self.assertEqual(self.rows('requests')[0], first)
        self.assertEqual(first['http_status'], 429)

    def test_denied_url_never_regets_but_recollected_url_can_continue(self):
        self.fixture([('alpha', [1])])
        self.run_batch(transfer=self.fail('access_denied_unknown', 403))
        jobs, requests, partials = self.rows('jobs'), self.rows('requests'), list((self.root / 'media/.partial').iterdir())
        blocked = self.run_batch(resume_requested=True)
        self.assertEqual(blocked['problem']['code'], 'url_recollection_required')
        self.assertEqual(self.rows('jobs'), jobs)
        self.assertEqual(self.rows('requests'), requests)
        self.data['미디어'][0]['다운로드URL'] += '_recollected'
        make_book(self.book, self.data)
        result = self.run_batch(resume_requested=True)
        self.assertIsNone(result['problem'])
        self.assertEqual(len(self.requests), 2)
        self.assertTrue(all(path.read_bytes() == b'preserve incomplete bytes' for path in partials))
        self.assertEqual(self.rows('requests')[0], requests[0])

    def test_request_reservation_enforces_denied_history_without_resume(self):
        self.fixture([('alpha', [1])])
        self.run_batch(transfer=self.fail('access_denied_unknown', 401))
        old = self.rows('requests')[0]
        with State(self.root, clock=self.clock) as state:
            with state.db:
                state.set_meta('stop', None)
            with self.assertRaises(StateError) as failure:
                state.reserve_request(old['job_id'], old['url_hash'], old['hostname'], 0)
        self.assertEqual(failure.exception.code, 'url_recollection_required')
        self.assertEqual(self.rows('requests'), [old])

    def test_new_excel_and_metadata_revalidate_existing_membership_only(self):
        self.fixture([('alpha', [2])])
        previous = self.planned()
        self.data['게시글'][0]['캡션'] = 'Collector refreshed metadata'
        make_book(self.book, self.data)
        other = samples(account='beta', day='2026-09-22', run='BetaRun')
        other['실행기록'][0]['특이사항'] = ''
        make_book(self.root / 'results/2026/09/threads-2026-09-22.xlsx', other)
        result = self.run_batch(resume_requested=True)
        self.assertIsNone(result['problem'])
        self.assertEqual(result['batch']['totalFiles'], 2)
        self.assertEqual(len(self.requests), 2)
        self.assertTrue(all('alpha_000' in row['url'] for row in self.requests))
        self.assertEqual([target['mediaId'] for target in self.meta()['targets']], [target['mediaId'] for target in previous['targets']])
        self.assertEqual(len(self.meta()['sources']), 2)
        self.assertEqual(len(self.rows('job_attempts')), 2)
        # Old planned attempts remain audit records, not active deletion guards.
        post = next(post for post in collection_view.read_snapshot(self.root)['snapshot']['posts']
                    if post['account'] == 'alpha')
        request = {'command': 'prepare', 'root': str(self.root), 'kind': 'post', 'postKey': post['key']}
        before = self.hashes()
        prepared = delete_media.execute(request)
        self.assertTrue(prepared['ok'])
        self.assertEqual(prepared['fileCount'], 2)
        deletion_plan = delete_media.plan(self.root, request)
        self.assertEqual({row['job_id'] for row in deletion_plan['jobs']}, {row['job_id'] for row in self.rows('jobs')})
        self.assertTrue({f"media/.partial/{target['jobId']}.part" for target in previous['targets']} <=
                        {item['path'] for item in deletion_plan['files']})
        self.assertEqual(self.hashes(), before)

    def test_delete_prepare_keeps_retired_incomplete_file_in_exact_scope(self):
        self.fixture([('alpha', [1])])
        self.run_batch(transfer=self.fail())
        failed = self.rows('jobs')[0]
        self.run_batch(resume_requested=True)
        post = collection_view.read_snapshot(self.root)['snapshot']['posts'][0]
        request = {'command': 'prepare', 'root': str(self.root), 'kind': 'post', 'postKey': post['key']}
        before = self.hashes()
        prepared = delete_media.execute(request)
        self.assertTrue(prepared['ok'])
        self.assertEqual(prepared['fileCount'], 2)  # Completed media + the preserved failed .part.
        deletion_plan = delete_media.plan(self.root, request)
        part = next(item for item in deletion_plan['files'] if item['path'] == failed['part_rel'])
        self.assertTrue(part['exists'])
        self.assertEqual(self.hashes(), before)

    def test_changed_carousel_and_missing_post_block_without_rewriting_plan(self):
        self.fixture([('alpha', [2])])
        original = self.planned()
        data = copy.deepcopy(self.data)
        self.data['게시글'][0]['이미지 수'] = 3
        self.data['미디어'].append({**self.data['미디어'][0], '순서': 3})
        make_book(self.book, self.data)
        self.assertEqual(self.run_batch(resume_requested=True)['problem']['code'], 'source_target_changed')
        self.assertEqual(self.meta(), original)
        data['게시글'], data['미디어'] = [], []
        make_book(self.book, data)
        self.assertEqual(self.run_batch(resume_requested=True)['problem']['code'], 'source_target_missing')
        self.assertEqual(self.meta(), original)
        self.assertEqual(self.requests, [])

    def test_app_deleted_pending_post_is_excluded_with_original_plan_audited(self):
        self.fixture([('alpha', [1, 1])])
        original = self.planned()
        with State(self.root, clock=self.clock) as state:
            with state.db:
                state.db.execute('CREATE TABLE post_deletions(account TEXT,post_id TEXT,deleted_at TEXT)')
                state.db.execute('INSERT INTO post_deletions VALUES(?,?,?)', ('alpha', 'alpha_000', '2026-09-22T00:00:00Z'))
        result = self.run_batch(resume_requested=True)
        self.assertIsNone(result['problem'])
        self.assertEqual(result['batch']['totalFiles'], 1)
        self.assertIn('alpha_001', self.requests[0]['url'])
        self.assertEqual(self.meta('download_batch_history')[0]['plan'], original)
        self.assertEqual(len(self.rows('jobs')), 2)

    def test_resumed_short_remaining_round_keeps_original_boundary(self):
        self.fixture([('alpha', [3] * 16)])
        stopped = [False]
        def observe(event):
            if event['batch']['completedFiles'] == 42 and event['phase'] == 'waiting':
                stopped[0] = True
        first = self.run_batch(cancel=lambda: stopped[0], output=observe)
        self.assertEqual(first['batch']['completedFiles'], 42)
        self.run_batch(resume_requested=True)
        self.assertEqual(len(self.requests), 48)
        self.assertEqual(self.requests[45]['time'] - self.completions[44], 60)
        self.assertEqual([sum(target['round'] == number for target in self.meta()['targets']) for number in (1, 2)], [45, 3])

    def test_staged_final_resume_completes_locally_without_adopting_new_posts(self):
        self.fixture([('alpha', [1])])
        with patch.object(runner, '_publish', side_effect=OSError('Synthetic shutdown')):
            self.run_batch()
        other = samples(account='beta', day='2026-09-22', run='BetaRun')
        make_book(self.root / 'results/2026/09/threads-2026-09-22.xlsx', other)
        result = self.run_batch(resume_requested=True)
        self.assertIsNone(result['problem'])
        self.assertEqual(result['batch']['completedFiles'], 1)
        self.assertEqual(result['batch']['totalFiles'], 1)
        self.assertEqual(len(self.requests), 1)
        self.assertIsNone(self.meta('stop'))

    def test_last_staged_file_without_stop_completes_after_abrupt_exit(self):
        self.fixture([('alpha', [1])])
        with patch.object(runner, '_publish', side_effect=OSError('Synthetic shutdown')):
            self.run_batch()
        # A process killed after the staged commit never executes the error handler.
        with State(self.root, clock=self.clock) as state:
            with state.db:
                state.set_meta('stop', None)
                plan = state.meta(batch.META)
                plan['status'] = 'active'
                state.set_meta(batch.META, plan)
        result = self.run_batch(resume_requested=True)
        self.assertIsNone(result['problem'])
        self.assertFalse(result['resumable'])
        self.assertFalse(result['recoverable'])
        self.assertEqual(result['batch']['completedFiles'], 1)
        self.assertEqual(len(self.requests), 1)

    def test_restore_review_is_not_overridden(self):
        self.fixture([('alpha', [1])])
        self.planned()
        for code in ('database_restored', 'restored_history_review'):
            with State(self.root, clock=self.clock) as state:
                state.stop(code, requires_review=True)
            result = self.run_batch(resume_requested=True)
            self.assertEqual(result['problem']['code'], 'resume_review_required')
            self.assertFalse(result['resumable'])
            self.assertEqual(self.meta('stop')['code'], code)
        self.assertEqual(self.requests, [])

    def test_local_recovery_does_not_turn_restored_history_into_resumable_stop(self):
        self.fixture([('alpha', [1])])
        plan = self.planned()
        with State(self.root, clock=self.clock) as state:
            with state.db:
                state.db.execute("UPDATE jobs SET status='running' WHERE job_id=?", (plan['targets'][0]['jobId'],))
            state.stop('database_restored', requires_review=True)
        runner.recover(self.root, clock=self.clock)
        self.assertEqual(self.meta('stop')['code'], 'database_restored')
        self.assertFalse(recovery.read_status(self.root, clock=self.clock)['resumable'])
        self.assertEqual(self.requests, [])

    def test_clock_guard_preserves_existing_restore_review_gate_and_history(self):
        self.fixture([('alpha', [1])])
        self.planned()
        for code in ('database_restored', 'restored_history_review', 'completed_file_changed'):
            with self.subTest(code=code), State(self.root, clock=self.clock) as state:
                state.stop(code, requires_review=True)
                previous, history = state.meta('stop'), state.meta('stop_history')
                latest = state.meta('last_clock')
                self.clock.sleep(-100)
                try:
                    with self.assertRaises(StateError) as failure:
                        state.guard()
                    self.assertEqual(failure.exception.code, 'stopped')
                    self.assertEqual(state.meta('stop'), previous)
                    self.assertEqual(state.meta('stop_history'), history)
                    self.assertEqual(state.meta('last_clock'), latest)
                finally:
                    self.clock.sleep(100)
        self.assertEqual(self.requests, [])

    def test_completed_file_damage_blocks_resume_and_never_redownloads_it(self):
        self.fixture([('alpha', [2])])
        stopped = [False]
        self.run_batch(cancel=lambda: stopped[0], output=lambda event: stopped.__setitem__(0, event['phase'] == 'waiting'))
        path = next((self.root / 'media/files').rglob('*.jpg'))
        path.write_bytes(b'changed existing completed file')
        result = self.run_batch(resume_requested=True)
        self.assertEqual(result['problem']['code'], 'completed_file_changed')
        self.assertFalse(result['resumable'])
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(path.read_bytes(), b'changed existing completed file')

    def test_clock_rollback_requires_correct_time_and_retains_wait(self):
        self.fixture([('alpha', [1])])
        self.planned()
        deadline = self.clock() + 90
        with State(self.root, clock=self.clock) as state:
            state.wait_until(deadline)
            state.stop('clock_rollback', requires_review=True)
        self.clock.sleep(-100)
        self.assertFalse(recovery.read_status(self.root, clock=self.clock)['resumable'])
        blocked = self.run_batch(resume_requested=True)
        self.assertEqual(blocked['problem']['code'], 'clock_rollback')
        self.assertFalse(blocked['resumable'])
        self.assertEqual(self.requests, [])
        self.clock.sleep(100)
        result = self.run_batch(resume_requested=True)
        self.assertIsNone(result['problem'])
        self.assertGreaterEqual(self.requests[0]['time'], deadline)

    def test_retry_chain_preserves_each_failed_job_and_partial(self):
        self.fixture([('alpha', [1])])
        self.run_batch(transfer=self.fail())
        self.run_batch(transfer=self.fail(), resume_requested=True)
        previous = self.rows('jobs')
        result = self.run_batch(resume_requested=True)
        self.assertIsNone(result['problem'])
        self.assertTrue(all(row in self.rows('jobs') for row in previous))
        self.assertEqual(len(self.rows('job_attempts')), 2)
        self.assertEqual(len(self.rows('requests')), 3)
        self.assertEqual(len(list((self.root / 'media/.partial').iterdir())), 2)

    def test_attempt_link_failure_rolls_back_new_job_plan_and_stop_release(self):
        self.fixture([('alpha', [1])])
        self.run_batch(transfer=self.fail())
        previous_jobs, previous_requests = self.rows('jobs'), self.rows('requests')
        previous_plan, previous_stop = self.meta(), self.meta('stop')
        partial = {path: path.read_bytes() for path in (self.root / 'media/.partial').iterdir()}
        with patch.object(attempts, 'link', side_effect=OSError('Synthetic disk failure')):
            with self.assertRaises(OSError):
                self.run_batch(resume_requested=True)
        self.assertEqual(self.rows('jobs'), previous_jobs)
        self.assertEqual(self.rows('requests'), previous_requests)
        self.assertEqual(self.meta(), previous_plan)
        self.assertEqual(self.meta('stop'), previous_stop)
        self.assertEqual({path: path.read_bytes() for path in partial}, partial)
        self.assertEqual(len(self.requests), 1)

    def test_invalid_attempt_lineage_does_not_hide_completed_file(self):
        self.fixture([('alpha', [1])])
        self.run_batch(transfer=self.fail())
        self.run_batch(resume_requested=True)
        with State(self.root, clock=self.clock) as state:
            with state.db:
                state.db.execute('UPDATE job_attempts SET previous_job_id=replacement_job_id')
        with self.assertRaises(StateError) as failure:
            collection_view.read_state(self.root)
        self.assertEqual(failure.exception.code, 'invalid_attempt_history')

    def test_startup_status_has_no_state_creation_and_ignores_cancel_stream(self):
        self.fixture([('alpha', [1])])
        before = self.hashes()
        value = download_ui.execute(self.root, {'command': 'status'}, lambda: True)
        self.assertFalse(value['resumable'])
        self.assertEqual(self.hashes(), before)
        self.assertFalse((self.root / 'state').exists())
        self.assertFalse((self.root / '_work').exists())

    def test_startup_status_preserves_wait_counter_and_stop_without_raw_urls(self):
        self.fixture([('alpha', [2])])
        self.run_batch(transfer=self.fail('rate_limited', 429, self.clock()+300))
        before = self.hashes()
        value = recovery.read_status(self.root, clock=self.clock)
        self.assertEqual(value['nextAllowedAt'], self.clock()+300)
        self.assertEqual(value['problem']['code'], 'rate_limited')
        self.assertTrue(value['resumable'])
        self.assertFalse(value['recoverable'])
        self.assertEqual(value['batch']['totalFiles'], 2)
        self.assertEqual(value['target']['ordinal'], 1)
        self.assertNotIn('PRIVATE_TEST', json.dumps(value))
        self.assertNotIn(str(self.root), json.dumps(value))
        self.assertEqual(self.hashes(), before)

    def test_crash_wal_status_is_readonly_then_resume_links_interrupted_attempt(self):
        self.fixture([('alpha', [2])])
        self.planned()
        code = '''
import os,sys
from pathlib import Path
sys.path.insert(0,sys.argv[2])
from threads_runner.state import State
with State(Path(sys.argv[1]),clock=lambda:2000000000.) as state:
    job=state.meta('download_batch')['targets'][0]
    with state.db:
        state.db.execute("UPDATE jobs SET status='running' WHERE job_id=?",(job['jobId'],))
    state.reserve_request(job['jobId'],job['urlHash'],'scontent-test.cdninstagram.com',0)
    (state.root / ('media/.partial/'+job['jobId']+'.part')).write_bytes(b'abrupt partial')
    os._exit(7)
'''
        child = subprocess.run([sys.executable, '-I', '-B', '-c', code, str(self.root), str(SCRIPTS)], capture_output=True, text=True, timeout=10)
        self.assertEqual(child.returncode, 7, child.stderr)
        before = self.hashes()
        with patch('socket.getaddrinfo', side_effect=AssertionError('No network')):
            status = recovery.read_status(self.root, clock=self.clock)
        self.assertTrue(status['recoverable'])
        self.assertTrue(status['resumable'])
        self.assertEqual(status['batch']['completedFiles'], 0)
        self.assertEqual(self.hashes(), before)
        result = self.run_batch(resume_requested=True)
        self.assertIsNone(result['problem'])
        self.assertEqual(len(self.requests), 2)
        self.assertEqual(len(self.rows('requests')), 3)
        self.assertEqual(len(self.rows('job_attempts')), 1)
        self.assertEqual(list((self.root / 'media/.partial').iterdir())[0].read_bytes(), b'abrupt partial')

    def test_live_or_collector_lock_never_recovers_or_starts_network(self):
        self.fixture([('alpha', [1])])
        self.planned()
        with State(self.root, clock=self.clock):
            before = self.hashes()
            for action in (lambda: recovery.read_status(self.root, clock=self.clock), lambda: self.run_batch(resume_requested=True)):
                with self.assertRaises(StateError) as failure:
                    action()
                self.assertEqual(failure.exception.code, 'busy')
            self.assertEqual(self.hashes(), before)
        self.assertEqual(self.requests, [])

    def test_worker_status_and_resume_reject_renderer_supplied_targets(self):
        for command in ('status', 'resume', 'continue'):
            with self.assertRaises(StateError) as failure:
                download_ui.execute(self.root, {'command': command, 'plan': {}}, lambda: False)
            self.assertEqual(failure.exception.code, 'invalid_request')


if __name__ == '__main__':
    unittest.main()
