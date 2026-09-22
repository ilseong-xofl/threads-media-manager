"""Deletion exclusion uses synthetic collections; no network or real user data."""
import copy
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local-runtime'))
import collection_view as view
import edit_media
from threads_runner import batch, deletion_state, inspection, recovery, runner, transport
from threads_runner.state import State, StateError
import test_batch_download as batch_fixture
import test_media_edit as edit_fixture
from test_download_excel import make_book


class DeletionVisibilityTests(unittest.TestCase):
    def setUp(self):
        self.fixture = batch_fixture.BatchDownloadTests()
        self.fixture.setUp()
        self.root = self.fixture.root

    def tearDown(self):
        self.fixture.tearDown()

    def mark_post(self, account, post_id):
        with closing(sqlite3.connect(self.root / 'state/state.db')) as db:
            db.execute('CREATE TABLE IF NOT EXISTS post_deletions(account TEXT,post_id TEXT,deleted_at TEXT,PRIMARY KEY(account,post_id))')
            db.execute('INSERT INTO post_deletions VALUES(?,?,?)', (account, post_id, '2026-09-22T12:00:00+09:00'))
            db.commit()

    def preserved(self):
        with closing(sqlite3.connect(self.root / 'state/state.db')) as db:
            return {name: db.execute(f'SELECT * FROM {name}').fetchall() for name in ('jobs', 'media', 'requests', 'meta')}

    def write_marks(self, *, date_column='삭제시각(KST)', value='Y'):
        self.fixture.data['게시글'][0].update({'삭제여부': value, date_column: '2026-09-22T12:00:00+09:00'})
        with patch.dict(runner.excel_input.SHEETS, {'게시글': (*runner.excel_input.POST_HEADERS, '삭제여부', date_column)}):
            make_book(self.fixture.book, self.fixture.data)

    def test_deleted_completed_file_does_not_block_other_post_or_change_history(self):
        self.fixture.fixture([('alpha', [1])])
        self.assertIsNone(self.fixture.run_batch()['problem'])
        with closing(sqlite3.connect(self.root / 'state/state.db')) as db:
            old = db.execute('SELECT job_id,media_id,final_rel FROM jobs').fetchone()
        self.mark_post('alpha', 'alpha_000')
        (self.root / old[2]).unlink()
        self.fixture.fixture([('alpha', [1, 1])])
        before = self.preserved()
        status = inspection.read_status(self.root, clock=self.fixture.clock)
        self.assertIsNone(status['problem'])
        self.assertEqual(status['jobs'], [])
        self.assertEqual(status['links'], {})
        snapshot = view.read_snapshot(self.root)
        self.assertEqual([post['postId'] for post in snapshot['snapshot']['posts']], ['alpha_001'])
        with State(self.root, clock=self.fixture.clock) as state:
            batch._validate_saved(state)
            self.assertIsNotNone(runner._completed(state, old[1]))
        self.assertEqual(self.preserved(), before)
        wait = status['nextAllowedAt']
        result = self.fixture.run_batch()
        self.assertIsNone(result['problem'])
        self.assertEqual(result['batch']['totalPosts'], 1)
        self.assertEqual(len(self.fixture.requests), 2)
        self.assertIn('alpha_001', self.fixture.requests[-1]['url'])
        self.assertGreaterEqual(self.fixture.requests[-1]['time'], wait)
        after = self.preserved()
        self.assertIn(before['jobs'][0], after['jobs'])
        self.assertIn(before['media'][0], after['media'])
        self.assertEqual(after['requests'][:len(before['requests'])], before['requests'])

    def test_deleted_planned_job_is_not_pending_or_reused_by_new_batch(self):
        self.fixture.fixture([('alpha', [1, 1])])
        with patch.object(transport, 'dependencies'):
            original = runner.plan_one(self.root, 'alpha')['job_id']
        self.mark_post('alpha', 'alpha_000')
        self.assertEqual(inspection.read_status(self.root, clock=self.fixture.clock)['jobs'], [])
        with self.assertRaises(StateError) as caught:
            runner.download_one(self.root, original, download=lambda *_args, **_kwargs: self.fail('Deleted transfer'))
        self.assertEqual(caught.exception.code, 'post_deleted')
        result = self.fixture.run_batch()
        self.assertIsNone(result['problem'])
        self.assertEqual(result['batch']['totalPosts'], 1)
        self.assertEqual(len(self.fixture.requests), 1)
        self.assertIn('alpha_001', self.fixture.requests[0]['url'])
        with closing(sqlite3.connect(self.root / 'state/state.db')) as db:
            self.assertEqual(db.execute('SELECT status FROM jobs WHERE job_id=?', (original,)).fetchone()[0], 'planned')

    def test_excel_deletion_survives_new_unmarked_observation_without_creating_database(self):
        self.fixture.fixture([('alpha', [1, 1])])
        self.write_marks(date_column='삭제일(KST)')
        earlier = self.fixture.book.read_bytes()
        later = copy.deepcopy(self.fixture.data)
        for sheet, rows in later.items():
            for row in rows:
                row.pop('삭제여부', None)
                row.pop('삭제일(KST)', None)
                for key, value in list(row.items()):
                    if isinstance(value, str):
                        row[key] = value.replace('Run_alpha', 'Run_later').replace('2026-09-21', '2026-09-22')
        newer = self.root / 'results/2026/09/threads-2026-09-22.xlsx'
        make_book(newer, later)
        latest = newer.read_bytes()
        snapshot = view.read_snapshot(self.root)['snapshot']
        self.assertEqual(snapshot['sourceCount'], 2)
        self.assertEqual([post['postId'] for post in snapshot['posts']], ['alpha_001'])
        data = runner._source(self.root)
        self.assertEqual([post['게시글ID'] for post in data['posts']], ['alpha_001'])
        self.assertEqual(len(runner.excel_input.load_collection(self.root)['posts']), 2)
        self.assertEqual(self.fixture.book.read_bytes(), earlier)
        self.assertEqual(newer.read_bytes(), latest)
        self.assertFalse((self.root / 'state').exists())

    def test_canonical_mark_filters_source_but_preserves_fingerprints_and_collector_rows(self):
        self.fixture.fixture([('alpha', [1, 1])])
        self.write_marks()
        raw = runner.excel_input.load_collection(self.root)
        filtered = deletion_state.load_source(self.root)
        self.assertEqual(filtered['sources'], raw['sources'])
        self.assertEqual(filtered['media'][0]['_source_sha256'], raw['media'][1]['_source_sha256'])
        self.assertEqual([row['게시글ID'] for row in filtered['posts']], ['alpha_001'])
        self.assertEqual(len(view.excel_input.load_collection(self.root)['posts']), 2)
        self.write_marks(value='N')
        self.assertEqual(len(view.read_snapshot(self.root)['snapshot']['posts']), 2)

    def test_db_tombstone_still_hides_new_observation_without_excel_mark(self):
        self.fixture.fixture([('alpha', [1, 1])])
        with State(self.root):
            pass
        self.mark_post('alpha', 'alpha_000')
        self.fixture.data['게시글'][0]['캡션'] = 'Later source information does not undelete this post'
        make_book(self.fixture.book, self.fixture.data)
        self.assertEqual([post['postId'] for post in view.read_snapshot(self.root)['snapshot']['posts']], ['alpha_001'])
        self.assertEqual([post['게시글ID'] for post in runner._source(self.root)['posts']], ['alpha_001'])

    def test_deleted_edit_keeps_recrop_child_visible_and_original_download_history_unchanged(self):
        fixture = edit_fixture.MediaEditTests()
        fixture.setUp()
        try:
            first = edit_media.execute(fixture.request)['mediaId']
            second = edit_media.execute({**fixture.request, 'mediaId': first,
                'crop': {'x': 1, 'y': 1, 'width': 2, 'height': 3}})['mediaId']
            before = fixture.preserved()
            with closing(sqlite3.connect(fixture.root / 'state/state.db')) as db:
                db.execute('CREATE TABLE edit_deletions(edit_id TEXT PRIMARY KEY,deleted_at TEXT)')
                db.execute('INSERT INTO edit_deletions VALUES(?,?)', (first, '2026-09-22T12:00:00+09:00'))
                db.commit()
            fixture.edit_path(first).unlink()
            snapshot = view.read_snapshot(fixture.root)
            edits = snapshot['snapshot']['posts'][0]['edits']
            self.assertEqual([edit['mediaId'] for edit in edits], [second])
            self.assertEqual(edits[0]['sourceMediaId'], first)
            self.assertEqual(edits[0]['status'], 'saved')
            self.assertNotIn(first, [item['id'] for item in snapshot['files']])
            self.assertEqual(fixture.preserved(), before)
            with closing(sqlite3.connect(fixture.root / 'state/state.db')) as db:
                self.assertEqual(db.execute('SELECT count(*) FROM media_edits').fetchone()[0], 2)
            third = edit_media.execute({**fixture.request, 'mediaId': second,
                'crop': {'x': 0, 'y': 0, 'width': 1, 'height': 2}})['mediaId']
            self.assertEqual([edit['mediaId'] for edit in view.read_snapshot(fixture.root)['snapshot']['posts'][0]['edits']], [second, third])
        finally:
            fixture.tearDown()

    def test_stop_wait_and_requests_survive_deleted_post_inspection_and_local_recovery(self):
        self.fixture.fixture([('alpha', [1])])
        self.fixture.run_batch()
        with State(self.root, clock=self.fixture.clock) as state:
            state.set_meta('stop', {'code': 'rate_limited', 'requires_review': True})
            state.set_meta('next_allowed', self.fixture.clock() + 500)
            state.db.commit()
        self.mark_post('alpha', 'alpha_000')
        before = self.preserved()
        status = inspection.read_status(self.root, clock=self.fixture.clock)
        self.assertEqual(status['problem']['code'], 'stopped')
        self.assertEqual(status['nextAllowedAt'], self.fixture.clock() + 500)
        recovered = runner.recover(self.root)
        self.assertEqual(recovered['recovered'], [])
        self.assertEqual(recovered['network_requests'], 0)
        self.assertEqual(self.preserved(), before)

    def test_pending_deletion_is_view_warning_but_blocks_transfer_and_download_recovery(self):
        self.fixture.fixture([('alpha', [1])])
        with State(self.root):
            pass
        journal = self.root / '_work' / ('delete-' + 'd'*32) / 'journal.json'
        journal.parent.mkdir()
        journal.write_text('{}')
        snapshot = view.read_snapshot(self.root)['snapshot']
        self.assertIn('deletion_recovery_required', [warning['code'] for warning in snapshot['warnings']])
        for callback in (lambda: inspection.read_status(self.root), lambda: runner.plan_one(self.root, 'alpha'),
                         lambda: runner.recover(self.root), lambda: recovery.release_abandoned(self.root)):
            with self.assertRaises(StateError) as caught:
                callback()
            self.assertEqual(caught.exception.code, 'deletion_recovery_required')
        self.assertTrue(journal.exists())

    def test_dead_delete_lock_without_journal_is_distinguished_from_other_or_live_locks(self):
        self.fixture.fixture([('alpha', [1])])
        work = self.root / '_work'
        work.mkdir()
        lock = work / 'collector.lock'
        for owner, dead, expected in [('media-delete', True, 'deletion_recovery_required'),
                                     ('media-delete', False, 'busy'), ('download-runner', True, 'busy'),
                                     ('collector', True, 'busy')]:
            lock.write_text(json.dumps({'owner': owner, 'token': 'a'*32, 'pid': 900000000}))
            before = lock.read_bytes()
            with patch.object(recovery, 'definitely_dead', return_value=dead), self.assertRaises(view.SourceError) as caught:
                view.read_snapshot(self.root)
            self.assertEqual(caught.exception.code, expected)
            self.assertEqual(lock.read_bytes(), before)

    def test_open_writer_deletions_use_current_connection_with_wal(self):
        self.fixture.fixture([('alpha', [1, 1])])
        with State(self.root) as state:
            state.db.execute('CREATE TABLE post_deletions(account TEXT,post_id TEXT,deleted_at TEXT,PRIMARY KEY(account,post_id))')
            state.db.execute('INSERT INTO post_deletions VALUES(?,?,?)', ('alpha', 'alpha_000', '2026-09-22T12:00:00+09:00'))
            state.db.commit()
            self.assertTrue((self.root / 'state/state.db-wal').stat().st_size)
            self.assertEqual([post['게시글ID'] for post in runner._source(self.root, db=state.db)['posts']], ['alpha_001'])


if __name__ == '__main__':
    unittest.main()
