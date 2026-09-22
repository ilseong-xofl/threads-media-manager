"""Local reply drafts persist without posting or modifying collection assets/history."""
from contextlib import closing
from datetime import datetime, timedelta
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import unittest
from unittest.mock import patch

import test_media_edit as fixtures
from test_collection_source import payload, workbook
import save_post_comment as comments
import post_draft as drafts
from threads_runner.state import StateError
from threads_source.files import CollectionLock, SourceError


class PostCommentTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.MediaEditTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.root = self.fixture.root
        self.request = {"root": str(self.root), "postKey": self.fixture.key,
            "caption": "  준비한 답글 🙂\n두 번째 줄\t유지  ", "link": " https://example.test/item?id=one#details "}
        self.draft_request = {"root": str(self.root), "postKey": self.fixture.key,
            "caption": "등록한 게시글", "mediaIds": [self.fixture.ids[0]], "expectedRevision": None}
        self.draft = drafts.execute(self.draft_request)["draft"]
        self.before = self.fixture.preserved()

    def rows(self):
        with closing(sqlite3.connect(self.root / "state/state.db")) as db:
            if not db.execute("SELECT 1 FROM sqlite_master WHERE name='post_comments'").fetchone(): return None
            return db.execute("SELECT account,post_id,caption,link,updated_at FROM post_comments ORDER BY account,post_id").fetchall()

    def preserved(self):
        self.assertEqual(self.fixture.preserved(), self.before)
        self.assertFalse((self.root / "_work/collector.lock").exists())

    def test_normalized_caption_link_persist_and_original_caption_is_unchanged(self):
        before_snapshot = self.fixture.snapshot()
        with patch("socket.create_connection", side_effect=AssertionError("No network allowed")):
            result = comments.execute(self.request)
        self.assertEqual(result["postKey"], self.fixture.key)
        self.assertEqual(result["comment"]["caption"], "준비한 답글 🙂\n두 번째 줄\t유지")
        self.assertEqual(result["comment"]["link"], "https://example.test/item?id=one#details")
        self.assertEqual(datetime.fromisoformat(result["comment"]["updatedAt"]).utcoffset(), timedelta(0))
        after = self.fixture.snapshot()["snapshot"]["posts"][0]
        self.assertEqual(after["comment"], result["comment"])
        self.assertEqual(after["caption"], before_snapshot["snapshot"]["posts"][0]["caption"])
        self.assertEqual(after["draft"], self.draft)
        self.assertEqual(self.rows(), [("Example", "AbC_01", result["comment"]["caption"], result["comment"]["link"], result["comment"]["updatedAt"])])
        self.preserved()

    def test_update_is_one_row_and_either_field_may_be_empty(self):
        first = comments.execute(self.request)
        second = comments.execute({**self.request, "caption": "수정한 댓글", "link": ""})
        self.assertEqual(len(self.rows()), 1)
        self.assertEqual(self.rows()[0][2:4], ("수정한 댓글", ""))
        self.assertGreaterEqual(second["comment"]["updatedAt"], first["comment"]["updatedAt"])
        third = comments.execute({**self.request, "caption": "\n\t ", "link": " HTTPS://예시.한국/링크 "})
        self.assertEqual(third["comment"]["caption"], "")
        self.assertEqual(third["comment"]["link"], "HTTPS://예시.한국/링크")
        self.assertEqual(self.fixture.snapshot()["snapshot"]["posts"][0]["comment"], third["comment"])
        self.preserved()

    def test_same_post_id_on_other_account_has_independent_comment(self):
        original, other = payload(), payload("RunB", account="Other")
        original["posts"][0]["영상 수"] = 1
        original["media"].append({**original["media"][0], "순서": 2, "종류": "video"})
        workbook(self.fixture.source, {"게시글": [*original["posts"], *other["posts"]],
            "미디어": [*original["media"], *other["media"]], "실행기록": [original["run"], other["run"]]})
        media_id = "d"*32
        relative = f"media/files/{self.fixture.library}/{media_id}.png"
        path = self.root / relative
        path.parent.mkdir(exist_ok=True)
        path.write_bytes(self.fixture.raw_image)
        with closing(sqlite3.connect(self.root / "state/state.db")) as db, db:
            db.row_factory = sqlite3.Row
            row = dict(db.execute("SELECT * FROM jobs WHERE media_id=?", (self.fixture.ids[0],)).fetchone())
            row.update(job_id="e"*32, media_id=media_id, final_rel=relative)
            db.execute("INSERT INTO media VALUES(?,?,?,?,?)", (media_id, "Other", "AbC_01", 1, "image"))
            db.execute(f"INSERT INTO jobs({','.join(row)}) VALUES({','.join('?' for _ in row)})", tuple(row.values()))
        self.before = self.fixture.preserved()
        comments.execute(self.request)
        second_key = '["Other","AbC_01"]'
        drafts.execute({**self.draft_request, "postKey": second_key, "mediaIds": [media_id]})
        comments.execute({**self.request, "postKey": second_key, "caption": "별도 계정의 답글"})
        stored = {row[:2]: row[2] for row in self.rows()}
        self.assertEqual(stored, {("Example", "AbC_01"): self.request["caption"].strip(), ("Other", "AbC_01"): "별도 계정의 답글"})
        posts = {post["key"]: post for post in self.fixture.snapshot()["snapshot"]["posts"]}
        self.assertNotEqual(posts[self.fixture.key]["comment"], posts[second_key]["comment"])
        self.preserved()

    def test_invalid_text_and_links_never_create_comment_table(self):
        invalid = [{"caption": " \n ", "link": ""}, {"caption": "가"*10001}, {"caption": "🙂"*5001},
            {"caption": "nul\0text"}, {"caption": "text\x7f"}, {"caption": None}, {"link": "https://example.test/"+"a"*2048}]
        invalid += [{"link": value} for value in ("file:///tmp/private", "javascript:alert(1)", "http:example.test", "//example.test",
            "https://", "https://user:password@example.test", "https://@example.test", "https://example.test:99999",
            "https://example.test:wrong", "https://exam ple.test", "https://example.test/path\nnext", "https://example.test\\path", "https://[broken")]
        invalid += [{"link": value} for value in ("https://<bad>", "https://bad^host.test", "https://bad|host.test",
            "https://%3Cbad%3E", "https://bad%2Fhost.test", "https://bad%00host.test", "https://bad%2host.test", "https://bad%FFhost.test")]
        for changes in invalid:
            with self.subTest(changes=repr(changes)[:80]), self.assertRaises(comments.CommentError):
                comments.execute({**self.request, **changes})
        self.assertIsNone(self.rows())
        self.preserved()

    def test_valid_ipv6_and_percent_encoded_domain_remain_local_text(self):
        for link in ("https://[2001:db8::1]:443/example", "https://%65xample.test/path", "http://localhost:8080/한글"):
            with self.subTest(link=link):
                saved = comments.execute({**self.request, "link": link})
                self.assertEqual(saved["comment"]["link"], link)
                self.assertEqual(self.fixture.snapshot()["snapshot"]["posts"][0]["comment"], saved["comment"])
        self.preserved()

    def test_maximum_utf16_text_is_accepted_with_newlines_and_emoji(self):
        value = "🙂"*4999+"한글"
        result = comments.execute({**self.request, "caption": value, "link": ""})
        self.assertEqual(result["comment"]["caption"], value)
        self.assertEqual(self.fixture.snapshot()["snapshot"]["posts"][0]["comment"], result["comment"])
        self.preserved()

    def test_missing_or_unregistered_posts_are_not_eligible(self):
        with self.assertRaises(comments.CommentError) as caught:
            comments.execute({**self.request, "postKey": '["Example","missing"]'})
        self.assertEqual(caught.exception.code, "post_missing")
        drafts.execute({"root": str(self.root), "postKey": self.fixture.key, "kind": "delete", "expectedRevision": 1})
        with self.assertRaises(comments.CommentError) as caught: comments.execute(self.request)
        self.assertEqual(caught.exception.code, "comment_draft_missing")
        self.assertIsNone(self.rows())
        self.preserved()

    def test_missing_selected_or_unselected_originals_do_not_block_registered_comment(self):
        for ordinal, path in enumerate(self.fixture.originals):
            with self.subTest(ordinal=ordinal):
                raw = path.read_bytes()
                path.unlink()
                try:
                    result = comments.execute(self.request)
                    post = self.fixture.snapshot()["snapshot"]["posts"][0]
                    self.assertEqual(post["attachments"][ordinal]["status"], "review")
                    self.assertEqual(post["comment"], result["comment"])
                    self.assertEqual(post["draft"], self.draft)
                    self.assertFalse(path.exists())
                finally:
                    path.write_bytes(raw)
                self.preserved()

    def test_broken_edit_does_not_block_registered_comment(self):
        media_id = fixtures.editor.execute(self.fixture.request)["mediaId"]
        self.fixture.edit_path(media_id).unlink()
        result = comments.execute(self.request)
        self.assertTrue(result["ok"])
        post = self.fixture.snapshot()["snapshot"]["posts"][0]
        self.assertEqual(post["edits"][0]["status"], "review")
        self.assertEqual(post["comment"], result["comment"])
        self.preserved()

    def test_existing_comment_remains_readable_after_draft_delete_and_reregistration(self):
        saved = comments.execute(self.request)["comment"]
        rows = self.rows()
        drafts.execute({"root": str(self.root), "postKey": self.fixture.key, "kind": "delete", "expectedRevision": 1})
        post = self.fixture.snapshot()["snapshot"]["posts"][0]
        self.assertNotIn("draft", post)
        self.assertEqual(post["comment"], saved)
        with self.assertRaises(comments.CommentError) as caught:
            comments.execute({**self.request, "caption": "not registered"})
        self.assertEqual(caught.exception.code, "comment_draft_missing")
        self.assertEqual(self.rows(), rows)
        drafts.execute(self.draft_request)
        self.assertEqual(self.fixture.snapshot()["snapshot"]["posts"][0]["comment"], saved)
        self.assertEqual(self.rows(), rows)
        self.preserved()

    def test_corrupt_registration_blocks_comment_changes_and_preserves_existing_text(self):
        comments.execute(self.request)
        before = self.rows()
        with closing(sqlite3.connect(self.root / "state/state.db")) as db, db:
            db.execute("UPDATE post_drafts SET media_ids_json='not json'")
        with self.assertRaises(comments.CommentError) as caught:
            comments.execute({**self.request, "caption": "not saved"})
        self.assertEqual(caught.exception.code, "drafts_unavailable")
        self.assertEqual(self.rows(), before)
        self.preserved()

    def test_registration_deleted_after_preflight_is_rechecked_inside_transaction(self):
        comments.execute(self.request)
        before = self.rows()
        actual = fixtures.view.read_snapshot
        reads = 0
        def remove_registration(*args, **kwargs):
            nonlocal reads
            result = actual(*args, **kwargs)
            reads += 1
            if reads == 2:
                # Another local writer changes registration after the last
                # source snapshot but before this worker opens its transaction.
                with closing(sqlite3.connect(self.root / "state/state.db")) as db, db:
                    db.execute("DELETE FROM post_drafts")
            return result
        with patch.object(fixtures.view, "read_snapshot", side_effect=remove_registration):
            with self.assertRaises(comments.CommentError) as caught:
                comments.execute({**self.request, "caption": "not saved"})
        self.assertEqual(caught.exception.code, "comment_draft_missing")
        self.assertEqual(self.rows(), before)
        self.assertNotIn("draft", self.fixture.snapshot()["snapshot"]["posts"][0])
        self.preserved()

    def test_foreign_lock_and_pending_delete_keep_existing_comment_unchanged(self):
        comments.execute(self.request)
        before = self.rows()
        with CollectionLock(self.root):
            raw = (self.root / "_work/collector.lock").read_bytes()
            with self.assertRaises(SourceError): comments.execute(self.request)
            self.assertEqual((self.root / "_work/collector.lock").read_bytes(), raw)
        journal = self.root / ("_work/delete-"+"f"*32) / "journal.json"
        journal.parent.mkdir()
        journal.write_text("{}")
        with self.assertRaises(StateError) as caught: comments.execute(self.request)
        self.assertEqual(caught.exception.code, "deletion_recovery_required")
        self.assertEqual(self.rows(), before)
        self.preserved()

    def test_deleted_post_cannot_receive_a_new_comment(self):
        with closing(sqlite3.connect(self.root / "state/state.db")) as db, db:
            db.execute("CREATE TABLE post_deletions(account TEXT,post_id TEXT,deleted_at TEXT,PRIMARY KEY(account,post_id))")
            db.execute("INSERT INTO post_deletions VALUES(?,?,?)", ("Example", "AbC_01", "2026-09-22T00:00:00Z"))
        with self.assertRaises(comments.CommentError) as caught: comments.execute(self.request)
        self.assertEqual(caught.exception.code, "post_missing")
        self.assertIsNone(self.rows())
        self.preserved()

    def test_corrupt_existing_comments_are_not_silently_replaced(self):
        comments.execute(self.request)
        with closing(sqlite3.connect(self.root / "state/state.db")) as db, db:
            db.execute("UPDATE post_comments SET updated_at='broken date'")
        before = self.rows()
        with self.assertRaises(comments.CommentError) as caught: comments.execute({**self.request, "caption": "replacement"})
        self.assertEqual(caught.exception.code, "comments_unavailable")
        self.assertEqual(self.rows(), before)
        self.preserved()

    def test_cancel_after_upsert_rolls_back_update_or_new_optional_table(self):
        actual = comments.write_comment
        stopped = False
        def writing(*args):
            nonlocal stopped
            actual(*args)
            stopped = True
        with patch.object(comments, "write_comment", side_effect=writing):
            with self.assertRaises(comments.CommentError) as caught: comments.execute(self.request, check=lambda: stopped)
        self.assertEqual(caught.exception.code, "cancelled")
        self.assertIsNone(self.rows())
        comments.execute(self.request)
        before = self.rows()
        stopped = False
        with patch.object(comments, "write_comment", side_effect=writing):
            with self.assertRaises(comments.CommentError): comments.execute({**self.request, "caption": "not committed"}, check=lambda: stopped)
        self.assertEqual(self.rows(), before)
        self.preserved()

    def test_write_failure_rolls_back_without_changing_existing_draft(self):
        comments.execute(self.request)
        before = self.rows()
        actual = comments.write_comment
        def failing(*args):
            actual(*args)
            raise OSError("simulated storage failure")
        with patch.object(comments, "write_comment", side_effect=failing):
            with self.assertRaises(OSError): comments.execute({**self.request, "caption": "failed change"})
        self.assertEqual(self.rows(), before)
        self.preserved()

    def test_custom_comment_trigger_never_mutates_download_history(self):
        comments.execute(self.request)
        with closing(sqlite3.connect(self.root / "state/state.db")) as db, db:
            db.execute("CREATE TRIGGER unexpected_comment_change AFTER UPDATE ON post_comments BEGIN UPDATE jobs SET error_code='changed'; END")
        before = self.rows()
        with self.assertRaises(comments.CommentError) as caught: comments.execute({**self.request, "caption": "should not run"})
        self.assertEqual(caught.exception.code, "comments_unavailable")
        self.assertEqual(self.rows(), before)
        self.preserved()

    def test_source_change_while_preparing_prevents_saving(self):
        actual = fixtures.view.read_snapshot
        calls = 0
        def changed(*args, **kwargs):
            nonlocal calls
            calls += 1
            result = actual(*args, **kwargs)
            if calls == 1: self.fixture.originals[0].write_bytes(b"changed by another program")
            return result
        with patch.object(fixtures.view, "read_snapshot", side_effect=changed):
            with self.assertRaises(comments.CommentError) as caught: comments.execute(self.request)
        self.assertEqual(caught.exception.code, "source_changed")
        self.assertIsNone(self.rows())
        self.assertEqual(self.fixture.preserved()["tables"], self.before["tables"])

    def test_absent_database_is_not_initialized(self):
        root = self.fixture.base / "read-only-source"
        source = root / "results/2026/09/threads-2026-09-21.xlsx"
        source.parent.mkdir(parents=True)
        source.write_bytes(self.fixture.source.read_bytes())
        with self.assertRaises(comments.CommentError) as caught: comments.execute({**self.request, "root": str(root)})
        self.assertEqual(caught.exception.code, "comment_state_unavailable")
        self.assertFalse((root / "state").exists())
        self.assertFalse((root / "media").exists())

    def test_cli_isolated_mode_success_invalid_eof_and_sigterm_rollback(self):
        process = subprocess.run([sys.executable, "-I", "-B", comments.__file__], input=json.dumps(self.request),
            text=True, capture_output=True, timeout=15)
        self.assertEqual(process.returncode, 0, process.stderr+process.stdout)
        self.assertEqual(process.stderr, "")
        result = json.loads(process.stdout)
        self.assertEqual(self.fixture.snapshot()["snapshot"]["posts"][0]["comment"], result["comment"])
        before = self.rows()
        code = """
import os,signal,sys
sys.path.insert(0,sys.argv[1])
import save_post_comment as worker
real=worker.write_comment
def writing(*args):
    real(*args)
    os.kill(os.getpid(),signal.SIGTERM)
worker.write_comment=writing
sys.exit(worker.main())
"""
        cancelled = subprocess.run([sys.executable, "-I", "-B", "-c", code, str(Path(comments.__file__).parent)],
            input=json.dumps({**self.request, "caption": "cancelled update"}), text=True, capture_output=True, timeout=15)
        self.assertEqual(cancelled.returncode, 1, cancelled.stderr)
        self.assertEqual(json.loads(cancelled.stdout)["error"]["code"], "cancelled")
        self.assertEqual(self.rows(), before)
        invalid = subprocess.run([sys.executable, "-I", "-B", comments.__file__], input="", text=True, capture_output=True, timeout=15)
        self.assertEqual(invalid.returncode, 1)
        self.assertEqual(json.loads(invalid.stdout)["error"]["code"], "invalid_request")
        self.preserved()


if __name__ == "__main__": unittest.main()
