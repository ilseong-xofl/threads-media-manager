"""Source-only removals retain registered references; synthetic libraries only."""
from contextlib import closing
import hashlib
from pathlib import Path
import sqlite3
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local-runtime'))
import test_media_edit as fixtures
from test_ai_media import generation
import collection_view as view
import library_maintenance as maintenance
import post_draft
import save_post_comment
from threads_runner import deletion_state, inspection, recovery, source_cleanup
from threads_source import workbook_write


class SourceRetentionTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.MediaEditTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.root = self.fixture.root
        self.db_path = self.root / 'state/state.db'
        self.backup = self.fixture.base / 'retained.sqlite'
        self.key = ('Example', 'AbC_01')
        self.edit = fixtures.editor.execute(self.fixture.request)['mediaId']
        self.ai_path, self.ai_id = generation(self.fixture)
        self.ids = [self.fixture.ids[1], self.edit, self.ai_id]
        self.request = {'root': str(self.root), 'postKey': self.fixture.key,
                        'caption': 'Registered caption', 'mediaIds': self.ids, 'expectedRevision': None}
        post_draft.execute(self.request, include_ai=True)
        save_post_comment.execute({'root': str(self.root), 'postKey': self.fixture.key,
                                   'caption': 'Registered reply', 'link': ''})
        self.before_mark = self.fixture.source.read_bytes()
        with closing(sqlite3.connect(self.db_path)) as db, db:
            db.execute('CREATE TABLE source_deletions(account TEXT NOT NULL,post_id TEXT NOT NULL,deleted_at TEXT NOT NULL,PRIMARY KEY(account,post_id))')
            db.execute('INSERT INTO source_deletions VALUES(?,?,?)', (*self.key, '2026-09-28T10:00:00Z'))
        self.fixture.source.write_bytes(workbook_write.patch_workbook(self.before_mark, {
            '게시글': [(7, {'삭제여부': 'Y', '삭제시각(KST)': '2026-09-28T19:00:00+09:00'})]}))

    def snapshot(self):
        return view.read_snapshot(self.root, include_ai=True)

    def hashes(self):
        return {str(path.relative_to(self.root)): hashlib.sha256(path.read_bytes()).hexdigest()
                for path in self.root.rglob('*') if path.is_file()}

    def media_hashes(self):
        return {key: value for key, value in self.hashes().items()
                if key.startswith(('media/', 'ai-drafts/'))}

    def final_delete_marker(self):
        with closing(sqlite3.connect(self.db_path)) as db, db:
            db.execute('CREATE TABLE post_deletions(account TEXT NOT NULL,post_id TEXT NOT NULL,deleted_at TEXT NOT NULL,PRIMARY KEY(account,post_id))')
            db.execute('INSERT INTO post_deletions VALUES(?,?,?)', (*self.key, '2026-09-28T11:00:00Z'))

    def maintain(self, command):
        return maintenance.execute({'command': command, 'root': str(self.root),
            **({'path': str(self.backup)} if command != 'reconnect' else {}), 'appVersion': 'test'})

    def assert_retained(self):
        result = self.snapshot()
        self.assertEqual(len(result['snapshot']['posts']), 1)
        post = result['snapshot']['posts'][0]
        self.assertTrue(post['sourceDeleted'])
        self.assertTrue(post['downloadExcluded'])
        self.assertEqual(post['draft']['mediaIds'], self.ids)
        self.assertEqual(post['caption'], 'first\n두 번째')
        self.assertEqual(post['comment']['caption'], 'Registered reply')
        self.assertEqual({item['id'] for item in result['files']}, set(self.ids) | {self.fixture.ids[0]})
        for item in post['attachments'] + post['edits'] + post['aiImages']:
            self.assertEqual(item['status'], 'saved')
            self.assertEqual(item['localUrl'], 'threads-media://file/' + item['mediaId'])
        return post

    def test_retains_originals_edits_ai_comment_and_draft_even_with_excel_y_readonly(self):
        before = self.hashes()
        self.assert_retained()
        self.assertEqual(self.hashes(), before)
        self.assertEqual(deletion_state.source_deletions(self.root), {self.key})
        self.assertEqual(deletion_state.database_deletions(self.root)[0], set())
        self.assertEqual(view.retained_source_posts(self.root), {self.key})

    def test_legacy_excel_only_deletion_never_restores_a_draft(self):
        with closing(sqlite3.connect(self.db_path)) as db, db:
            db.execute('DELETE FROM source_deletions')
        before = self.hashes()
        result = self.snapshot()
        self.assertEqual(result['snapshot']['posts'], [])
        self.assertEqual(result['files'], [])
        self.assertEqual(self.hashes(), before)

    def test_final_deletion_wins_over_source_marker_and_existing_draft(self):
        self.final_delete_marker()
        before = self.hashes()
        self.assertEqual(view.retained_source_posts(self.root), set())
        self.assertEqual(self.snapshot()['snapshot']['posts'], [])
        self.assertEqual(self.snapshot()['files'], [])
        self.assertEqual(self.hashes(), before)

    def test_source_deletion_without_a_draft_stays_hidden(self):
        with closing(sqlite3.connect(self.db_path)) as db, db:
            db.execute('DELETE FROM post_drafts')
        before = self.hashes()
        self.assertEqual(self.snapshot()['snapshot']['posts'], [])
        self.assertEqual(self.snapshot()['files'], [])
        self.assertEqual(self.hashes(), before)

    def test_source_marker_alone_blocks_collection_jobs_and_recovery_without_hiding_registered_media(self):
        self.fixture.source.write_bytes(self.before_mark)
        before = self.hashes()
        with patch('socket.getaddrinfo', side_effect=AssertionError('Network prohibited')):
            self.assertEqual(deletion_state.load_source(self.root)['posts'], [])
            status = inspection.read_status(self.root)
            self.assertEqual(status['jobs'], [])
            self.assertEqual(status['links'], {})
            self.assertFalse(recovery.read_status(self.root)['recoverable'])
            with closing(sqlite3.connect(self.db_path)) as db:
                db.row_factory = sqlite3.Row
                self.assertEqual(deletion_state.active_jobs(SimpleNamespace(root=self.root, db=db)), [])
            self.assert_retained()
        self.assertEqual(self.hashes(), before)

    def test_source_cleanup_does_not_finalize_retained_registration(self):
        before = self.hashes()
        with patch('socket.getaddrinfo', side_effect=AssertionError('Network prohibited')):
            result = source_cleanup.clean(self.root)
        self.assertEqual(result['cleanedPosts'], 0)
        self.assertEqual(deletion_state.database_deletions(self.root)[0], set())
        self.assert_retained()
        self.assertEqual(self.hashes(), before)

    def test_backup_and_normal_restore_preserve_source_marker_and_shared_media(self):
        self.maintain('backup')
        with closing(sqlite3.connect(self.backup)) as db:
            maintenance.validate_db(db, backup=True)
            self.assertEqual(deletion_state.source_deletions(None, db), {self.key})
        post_draft.execute({**self.request, 'expectedRevision': 1, 'caption': 'New local revision'}, include_ai=True)
        before_media = self.media_hashes()
        result = self.maintain('restore')
        self.assertEqual(result['restore_mode'], 'metadata')
        self.assertEqual(deletion_state.source_deletions(self.root), {self.key})
        post = self.assert_retained()
        self.assertEqual(post['draft']['caption'], 'Registered caption')
        self.assertEqual(post['draft']['revision'], 3)
        self.assertEqual(self.media_hashes(), before_media)

    def test_older_metadata_backup_cannot_remove_last_registered_reference_or_comment(self):
        self.maintain('backup')
        with closing(sqlite3.connect(self.backup)) as db, db:
            db.execute('DELETE FROM post_drafts')
            db.execute('DELETE FROM post_comments')
        before_media = self.media_hashes()
        self.maintain('restore')
        post = self.assert_retained()
        self.assertEqual(post['draft']['caption'], 'Registered caption')
        self.assertEqual(self.media_hashes(), before_media)

    def test_backup_cannot_resurrect_a_finally_deleted_retained_post(self):
        self.maintain('backup')
        self.final_delete_marker()
        with closing(sqlite3.connect(self.db_path)) as db, db:
            db.execute('DELETE FROM post_drafts')
            db.execute('DELETE FROM post_comments')
        for path in self.fixture.originals:
            path.unlink()
        result = self.maintain('restore')
        self.assertEqual(result['restored_drafts'], 0)
        self.assertEqual(result['restored_comments'], 0)
        self.assertEqual(self.snapshot()['snapshot']['posts'], [])
        self.assertEqual(deletion_state.source_deletions(self.root), {self.key})
        self.assertEqual(deletion_state.database_deletions(self.root)[0], {self.key})

    def test_full_restore_retains_source_marker_and_files_without_new_hold(self):
        self.maintain('backup')
        before_media = self.media_hashes()
        self.db_path.unlink()
        result = self.maintain('restore')
        self.assertEqual(result['restore_mode'], 'full')
        self.assertFalse(result['history_review_required'])
        self.assertEqual(deletion_state.source_deletions(self.root), {self.key})
        self.assert_retained()
        self.assertEqual(self.media_hashes(), before_media)

    def test_old_full_backup_cannot_infer_source_only_deletion_from_excel_y(self):
        self.maintain('backup')
        with closing(sqlite3.connect(self.backup)) as db, db:
            db.execute('DELETE FROM source_deletions')
        before_media = self.media_hashes()
        self.db_path.unlink()
        result = self.maintain('restore')
        self.assertFalse(result['history_review_required'])
        self.assertEqual(self.snapshot()['snapshot']['posts'], [])
        self.assertEqual(self.snapshot()['files'], [])
        self.assertEqual(self.media_hashes(), before_media)

    def test_retained_media_is_still_validated_during_restore_despite_excel_y(self):
        self.maintain('backup')
        self.fixture.originals[0].write_bytes(b'changed retained media')
        before_db, before_media = self.db_path.read_bytes(), self.media_hashes()
        with self.assertRaises(maintenance.MaintenanceError):
            self.maintain('restore')
        self.assertEqual(self.db_path.read_bytes(), before_db)
        self.assertEqual(self.media_hashes(), before_media)


if __name__ == '__main__':
    unittest.main()
