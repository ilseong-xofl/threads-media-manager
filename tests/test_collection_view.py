"""Read-only app boundary tests; all writes use disposable synthetic collections."""
from contextlib import ExitStack, closing
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "local-runtime"))
import collection_view as view
from test_collection_source import payload, workbook
from threads_runner.state import State


class CollectionViewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.source = self.root / "results/2026/09/threads-2026-09-21.xlsx"

    def tearDown(self):
        self.temp.cleanup()

    def append(self, data=None):
        data = data or payload()
        day = data["run"]["수집일자(KST)"][:10]
        path = self.root / f"results/{day[:4]}/{day[5:7]}/threads-{day}.xlsx"
        if path.exists():
            old = view.excel_input.read_workbook(path)
        else:
            old = {"posts": [], "media": [], "runs": []}
        return workbook(path, {"게시글": old["posts"] + data["posts"], "미디어": old["media"] + data["media"], "실행기록": old["runs"] + [data["run"]]})

    def hashes(self):
        return {str(p.relative_to(self.root)): hashlib.sha256(p.read_bytes()).hexdigest() for p in self.root.rglob('*') if p.is_file()}

    def stored(self):
        media_id = 'a' * 32
        relative = 'media/files/' + 'b' * 32 + '/' + media_id + '.jpg'
        data = b'synthetic-local-content'
        with State(self.root) as state:
            path = self.root / relative
            path.parent.mkdir(parents=True)
            path.write_bytes(data)
            with state.db:
                state.db.execute('INSERT INTO media VALUES (?,?,?,?,?)', (media_id, 'Example', 'AbC_01', 1, 'image'))
                state.db.execute('''INSERT INTO jobs(job_id,media_id,source_rel,source_sha256,source_type,run_id,url_hash,status,final_rel,size,sha256,updated_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)''', ('c'*32, media_id, 'source', 'd'*64, 'jsonl', 'RunA', 'e'*64, 'complete', relative, len(data), hashlib.sha256(data).hexdigest(), 1))
                state.db.execute("INSERT INTO requests(job_id,url_hash,hostname,hop,consumed_at) VALUES (?,?,?,?,?)", ('c'*32,'e'*64,'cdn.example.test',0,123))
                state.set_meta('stop', {'code': 'previous_failure'})
        return path

    def test_empty_does_not_create_storage(self):
        result = view.read_snapshot(self.root)
        self.assertEqual(result['snapshot']['posts'], [])
        self.assertEqual(result['snapshot']['stateStatus'], 'absent')
        self.assertEqual(list(self.root.iterdir()), [])

    def test_source_is_read_only_and_remote_media_urls_are_not_returned(self):
        self.append()
        before = self.hashes()
        result = view.read_snapshot(self.root)
        self.assertEqual(before, self.hashes())
        self.assertNotIn('cdn.example.test', json.dumps(result))
        self.assertNotIn('sig=', json.dumps(result))
        self.assertEqual(result['snapshot']['posts'][0]['caption'], 'first\n두 번째')
        self.assertEqual(result['snapshot']['posts'][0]['attachments'][0]['status'], 'not_downloaded')
        self.assertFalse((self.root / 'state').exists())
        self.assertNotIn('comment', result['snapshot']['posts'][0])

    def test_saved_file_and_request_history_are_preserved(self):
        self.append()
        self.stored()
        before = self.hashes()
        result = view.read_snapshot(self.root)
        self.assertEqual(before, self.hashes())
        self.assertEqual(len(result['files']), 1)
        self.assertEqual(result['snapshot']['stateStatus'], 'read_only')
        self.assertEqual(result['snapshot']['posts'][0]['attachments'][0]['status'], 'saved')
        self.assertNotIn('comment', result['snapshot']['posts'][0])

    def test_duplicate_committed_transaction_merges_once(self):
        self.append()
        self.append()
        self.assertEqual(len(view.read_snapshot(self.root)['snapshot']['posts']), 1)

    def test_newer_partial_keeps_complete_caption_and_its_own_timestamp(self):
        self.append()
        data = payload('RunB', '2026-09-22')
        data['posts'][0].update({'캡션': 'short', '캡션 상태': 'partial', '첨부 상태': 'partial'})
        data['run'].update({'결과': 'partial', '누락상태': 'possible_gap'})
        self.append(data)
        post = view.read_snapshot(self.root)['snapshot']['posts'][0]
        self.assertEqual(post['caption'], 'first\n두 번째')
        self.assertTrue(post['captionObservedAt'].startswith('2026-09-21'))
        self.assertTrue(post['observedAt'].startswith('2026-09-22'))
        self.assertEqual(post['gapStatus'], 'possible_gap')
        self.assertEqual(post['attachmentStatus'], 'partial')
        self.assertIn('earlier_caption', post['reasons'])

    def test_conflicting_run_is_rejected(self):
        self.append()
        data = payload('Other')
        data['posts'][0]['캡션'] = 'conflicting text at the same time'
        self.append(data)
        before = self.hashes()
        with self.assertRaises(view.SourceError):
            view.read_snapshot(self.root)
        self.assertEqual(before, self.hashes())

    def test_corrupt_workbook_is_preserved(self):
        self.append()
        original = self.source.read_bytes()
        for raw in (b'not a workbook', original[:100]):
            self.source.write_bytes(raw)
            before = self.hashes()
            with self.assertRaises(view.SourceError):
                view.read_snapshot(self.root)
            self.assertEqual(before, self.hashes())

    def test_lock_is_respected_without_replacing_it(self):
        self.append()
        lock = self.root / '_work/collector.lock'
        lock.parent.mkdir()
        lock.write_text('{"owner":"collector"}')
        before = self.hashes()
        with self.assertRaises(view.SourceError) as caught:
            view.read_snapshot(self.root)
        self.assertEqual(caught.exception.code, 'busy')
        self.assertEqual(before, self.hashes())

    def test_source_change_during_snapshot_is_rejected(self):
        self.append()
        actual = view.excel_input.load_collection
        calls = 0
        def changed(root):
            nonlocal calls
            result = actual(root)
            calls += 1
            if calls == 2:
                result['sources'][0]['sha256'] = '0'*64
            return result
        with patch.object(view.excel_input, 'load_collection', side_effect=changed), self.assertRaises(view.SourceError) as caught:
            view.read_snapshot(self.root)
        self.assertEqual(caught.exception.code, 'source_changed')

    def test_invalid_db_does_not_hide_source_or_create_new_db(self):
        self.append()
        (self.root/'state').mkdir()
        (self.root/'state/state.db').write_bytes(b'broken')
        before = self.hashes()
        result = view.read_snapshot(self.root)
        self.assertEqual(result['snapshot']['stateStatus'], 'unavailable')
        self.assertEqual(len(result['snapshot']['posts']), 1)
        self.assertEqual(result['snapshot']['posts'][0]['attachments'][0]['status'], 'unavailable')
        self.assertEqual(before, self.hashes())

    def test_pending_wal_is_not_ignored_or_checkpointed(self):
        self.append()
        self.stored()
        (self.root/'state/state.db-wal').write_bytes(b'uncheckpointed')
        before = self.hashes()
        result = view.read_snapshot(self.root)
        self.assertEqual(result['snapshot']['stateStatus'], 'unavailable')
        self.assertEqual(result['snapshot']['warnings'][0]['code'], 'state_busy')
        self.assertEqual(result['files'], [])
        self.assertEqual(before, self.hashes())

    def test_changed_missing_or_symlink_file_is_not_served(self):
        self.append()
        file = self.stored()
        for operation in ('change', 'remove', 'symlink'):
            if operation == 'change': file.write_bytes(b'changed')
            elif operation == 'remove': file.unlink()
            else: file.symlink_to(self.source)
            result = view.read_snapshot(self.root)
            self.assertEqual(result['files'], [])
            self.assertEqual(result['snapshot']['posts'][0]['attachments'][0]['status'], 'review')

    def test_excel_and_state_symlinks_are_rejected(self):
        self.append()
        target = self.source.with_suffix('.backup')
        self.source.rename(target)
        self.source.symlink_to(target)
        with self.assertRaises((view.SourceError, view.InputError)): view.read_snapshot(self.root)
        self.source.unlink()
        target.rename(self.source)
        (self.root/'state').symlink_to(self.root/'results', target_is_directory=True)
        self.assertEqual(view.read_snapshot(self.root)['snapshot']['stateStatus'], 'unavailable')

    def test_missing_source_keeps_saved_connection(self):
        self.append()
        self.stored()
        self.source.unlink()
        post = view.read_snapshot(self.root)['snapshot']['posts'][0]
        self.assertEqual(post['caption'], '')
        self.assertEqual(post['reasons'], ['source_missing'])
        self.assertEqual(post['attachments'][0]['status'], 'saved')

    def test_snapshot_never_uses_network_or_mutating_runner(self):
        self.append()
        self.stored()
        with ExitStack() as stack:
            for name in ('socket.create_connection', 'urllib.request.urlopen', 'threads_runner.state.State.__enter__'):
                stack.enter_context(patch(name, side_effect=AssertionError('Forbidden side effect')))
            self.assertEqual(view.read_snapshot(self.root)['snapshot']['stateStatus'], 'read_only')

    def test_saved_attachment_missing_from_partial_source_is_retained(self):
        data = payload()
        data['posts'][0]['첨부 상태'] = 'partial'
        data['media'] = []
        self.append(data)
        self.stored()
        post = view.read_snapshot(self.root)['snapshot']['posts'][0]
        self.assertIn('attachment_source_missing', post['reasons'])
        self.assertEqual(post['attachments'][0]['status'], 'saved')

    def comments(self, rows, *, unique=True):
        with closing(sqlite3.connect(self.root / 'state/state.db')) as db:
            with db:
                db.execute('DROP TABLE IF EXISTS post_comments')
                db.execute('CREATE TABLE post_comments(account TEXT,post_id TEXT,caption TEXT,link TEXT,updated_at TEXT' +
                    (',PRIMARY KEY(account,post_id)' if unique else '') + ')')
                db.executemany('INSERT INTO post_comments VALUES(?,?,?,?,?)', rows)

    def test_comments_are_post_specific_and_read_only_with_existing_gallery(self):
        self.append()
        second = payload('OtherRun', account='Other')
        second['posts'][0]['원문URL'] = 'https://www.threads.com/@other/post/AbC_01'
        self.append(second)
        self.stored()
        when = '2026-09-22T10:20:30.123456+00:00'
        self.comments([('Example', 'AbC_01', '첫 댓글\n다음 줄', 'https://example.test/item?q=one', when),
            ('Other', 'AbC_01', '', 'HTTP://example.test/other', when),
            ('Example', 'NotInCollection', '고아 기록 보존', '', when)])
        before = self.hashes()
        result = view.read_snapshot(self.root)
        posts = {post['account']: post for post in result['snapshot']['posts']}
        self.assertEqual(posts['Example']['comment'], {'caption': '첫 댓글\n다음 줄',
            'link': 'https://example.test/item?q=one', 'updatedAt': when})
        self.assertEqual(posts['Other']['comment']['link'], 'HTTP://example.test/other')
        self.assertEqual(posts['Example']['attachments'][0]['status'], 'saved')
        self.assertEqual(posts['Other']['attachments'][0]['status'], 'not_downloaded')
        self.assertEqual(len(result['files']), 1)
        self.assertEqual(len(posts), 2)
        self.assertEqual(before, self.hashes())
        with closing(sqlite3.connect(self.root / 'state/state.db')) as db:
            with db:
                db.execute('UPDATE post_comments SET caption=? WHERE account=?', ('수정 댓글', 'Example'))
        updated = view.read_snapshot(self.root)
        self.assertEqual(next(post for post in updated['snapshot']['posts'] if post['account'] == 'Example')['comment']['caption'], '수정 댓글')

    def test_comment_remains_connected_to_saved_post_without_source(self):
        self.append()
        self.stored()
        self.comments([('Example', 'AbC_01', '저장 댓글', '', '2026-09-22T10:20:30Z')])
        self.source.unlink()
        before = self.hashes()
        post = view.read_snapshot(self.root)['snapshot']['posts'][0]
        self.assertEqual(post['comment']['caption'], '저장 댓글')
        self.assertEqual(post['attachments'][0]['status'], 'saved')
        self.assertEqual(before, self.hashes())

    def test_corrupt_comment_rows_warn_without_modifying_or_hiding_gallery(self):
        self.append()
        self.stored()
        valid = ['Example', 'AbC_01', '기존 댓글', 'https://example.test/item', '2026-09-22T10:20:30+00:00']
        changes = [(2, None), (2, '\x00broken'), (2, '🙂'*5001), (2, ' padded '),
            (3, 'javascript:alert(1)'), (3, 'https://user:pass@example.test'), (3, 'https://@example.test'),
            (3, 'https://example.test:99999'), (3, 'https://example.test/path with space'),
            (3, 'https://example.test/\\path'), (3, 'https:example.test'), (3, 'https://' + 'a'*2048),
            (3, 'https://<bad>'), (3, 'https://bad|host'), (3, 'https://bad^host'),
            (3, 'https://%3Cbad%3E'), (3, 'https://%00example.test'), (3, 'https://bad%2Fhost'),
            (3, 'https://%example.test'), (3, 'https://%FF.test'), (3, 'https://one..test'),
            (4, 'not-a-date'), (4, '2026-09-22T10:20:30'), (4, '2026-09-22T10:20:30+09:00'),
            (4, '2026-02-31T10:20:30Z')]
        for index, value in changes:
            with self.subTest(index=index, value=str(value)[:60]):
                row = valid.copy()
                row[index] = value
                self.comments([row])
                before = self.hashes()
                result = view.read_snapshot(self.root)
                self.assertIn('comments_unavailable', [warning['code'] for warning in result['snapshot']['warnings']])
                self.assertNotIn('comment', result['snapshot']['posts'][0])
                self.assertEqual(result['snapshot']['posts'][0]['attachments'][0]['status'], 'saved')
                self.assertEqual(len(result['files']), 1)
                self.assertEqual(before, self.hashes())

    def test_comment_hostname_validation_preserves_valid_local_and_encoded_hosts(self):
        self.append()
        self.stored()
        for link in ('https://[::1]:8443/path', 'https://%65xample.test/item',
                     'http://localhost:8080/path', 'https://한글.test/path'):
            with self.subTest(link=link):
                self.comments([('Example', 'AbC_01', '링크 유지', link, '2026-09-22T10:20:30Z')])
                before = self.hashes()
                result = view.read_snapshot(self.root)
                self.assertEqual(result['snapshot']['posts'][0]['comment']['link'], link)
                self.assertNotIn('comments_unavailable', [warning['code'] for warning in result['snapshot']['warnings']])
                self.assertEqual(before, self.hashes())

    def test_missing_columns_duplicate_rows_and_view_are_not_treated_as_absent_comments(self):
        self.append()
        self.stored()
        row = ('Example', 'AbC_01', '기존 댓글', '', '2026-09-22T10:20:30Z')
        self.comments([row, row], unique=False)
        for kind in ('duplicate', 'missing_column', 'view'):
            with self.subTest(kind=kind):
                if kind != 'duplicate':
                    with closing(sqlite3.connect(self.root / 'state/state.db')) as db:
                        with db:
                            db.execute('DROP TABLE post_comments')
                            db.execute('CREATE TABLE post_comments(caption TEXT)' if kind == 'missing_column'
                                else "CREATE VIEW post_comments AS SELECT 'existing' AS caption")
                before = self.hashes()
                result = view.read_snapshot(self.root)
                self.assertIn('comments_unavailable', [warning['code'] for warning in result['snapshot']['warnings']])
                self.assertEqual(result['snapshot']['posts'][0]['attachments'][0]['status'], 'saved')
                self.assertEqual(before, self.hashes())

    def test_deleted_post_comments_never_restore_the_post(self):
        self.append()
        self.stored()
        self.comments([('Example', 'AbC_01', '기록은 보존', '', '2026-09-22T10:20:30Z')])
        with closing(sqlite3.connect(self.root / 'state/state.db')) as db:
            with db:
                db.execute('CREATE TABLE post_deletions(account TEXT,post_id TEXT,deleted_at TEXT,PRIMARY KEY(account,post_id))')
                db.execute('INSERT INTO post_deletions VALUES(?,?,?)', ('Example', 'AbC_01', '2026-09-22T11:00:00Z'))
        before = self.hashes()
        result = view.read_snapshot(self.root)
        self.assertEqual(result['snapshot']['posts'], [])
        self.assertEqual(result['files'], [])
        self.assertEqual(before, self.hashes())


if __name__ == '__main__': unittest.main()
