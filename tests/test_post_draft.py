"""Single-post local drafts: reference order, CAS writes, preservation, and deletion."""
from contextlib import closing
from datetime import datetime, timedelta
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import unittest
from unittest.mock import patch
import zipfile

import test_media_edit as fixtures
from test_collection_source import payload, workbook
import delete_media as deletion
import post_draft as drafts
from threads_runner.state import StateError
from threads_source.files import CollectionLock, SourceError


class PostDraftTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.MediaEditTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.root = self.fixture.root
        self.request = {"root": str(self.root), "postKey": self.fixture.key, "caption": "  새 문구 🙂\n줄바꿈 유지  ",
            "mediaIds": [self.fixture.ids[1], self.fixture.ids[0]], "expectedRevision": None}
        self.before = self.fixture.preserved()

    def stored(self):
        with closing(sqlite3.connect(self.root / "state/state.db")) as db:
            return fixtures.view.read_drafts(self.root, db=db)

    def current(self): return self.fixture.snapshot()["snapshot"]["posts"][0].get("draft")

    def assert_preserved(self):
        self.assertEqual(self.fixture.preserved(), self.before)
        self.assertFalse((self.root / "_work/collector.lock").exists())

    def files(self):
        return {path.relative_to(self.root).as_posix(): path.read_bytes() for path in (self.root / "media").rglob("*") if path.is_file()}

    def edit(self): return fixtures.editor.execute(self.fixture.request)["mediaId"]

    def prepare_delete(self, media_id=None):
        request = {"root": str(self.root), "postKey": self.fixture.key, "kind": "edit" if media_id else "post", "command": "prepare"}
        if media_id: request["mediaId"] = media_id
        prepared = deletion.execute(request)
        return {**request, "command": "commit", "fingerprint": prepared["fingerprint"]}

    def other_post(self):
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
        return '["Other","AbC_01"]', media_id, path

    def crash_delete(self, request, after=False):
        code = """
import json,os,sys
sys.path.insert(0,sys.argv[1])
import delete_media as worker
real=worker.apply_tombstone
def crash(*args):
    if sys.argv[3]=='after': real(*args)
    os._exit(92)
worker.apply_tombstone=crash
worker.execute(json.loads(sys.argv[2]))
"""
        process = subprocess.run([sys.executable, "-I", "-B", "-c", code, str(Path(deletion.__file__).parent),
            json.dumps(request), "after" if after else "before"], capture_output=True, timeout=15)
        self.assertEqual(process.returncode, 92, process.stderr)

    def test_absent_draft_read_is_read_only_and_does_not_create_table(self):
        raw = (self.root / "state/state.db").read_bytes()
        self.assertIsNone(self.current())
        self.assertEqual(self.stored(), {})
        self.assertEqual((self.root / "state/state.db").read_bytes(), raw)
        with closing(sqlite3.connect(self.root / "state/state.db")) as db:
            self.assertIsNone(db.execute("SELECT 1 FROM sqlite_master WHERE name='post_drafts'").fetchone())
        self.assert_preserved()

    def test_save_orders_originals_and_edits_without_copying_media_or_source_caption(self):
        edit = self.edit()
        before_files = self.files()
        request = {**self.request, "mediaIds": [edit, self.fixture.ids[1], self.fixture.ids[0]]}
        with patch("socket.create_connection", side_effect=AssertionError("No network")):
            result = drafts.execute(request)
        self.assertTrue(result["ok"])
        self.assertEqual(result["postKey"], self.fixture.key)
        self.assertEqual(result["draft"]["caption"], self.request["caption"])
        self.assertEqual(result["draft"]["mediaIds"], request["mediaIds"])
        self.assertEqual(result["draft"]["revision"], 1)
        self.assertEqual(result["draft"]["createdAt"], result["draft"]["updatedAt"])
        self.assertEqual(datetime.fromisoformat(result["draft"]["createdAt"]).utcoffset(), timedelta(0))
        post = self.fixture.snapshot()["snapshot"]["posts"][0]
        self.assertEqual(post["draft"], result["draft"])
        self.assertNotEqual(post["caption"], result["draft"]["caption"])
        self.assertEqual(self.files(), before_files)
        self.assert_preserved()

    def test_update_reorders_removes_selection_and_keeps_created_at(self):
        first = drafts.execute(self.request)["draft"]
        second = drafts.execute({**self.request, "expectedRevision": 1, "caption": "", "mediaIds": [self.fixture.ids[0]]})["draft"]
        self.assertEqual(second["revision"], 2)
        self.assertEqual(second["createdAt"], first["createdAt"])
        self.assertGreaterEqual(second["updatedAt"], first["updatedAt"])
        self.assertEqual(second["caption"], "")
        self.assertEqual(second["mediaIds"], [self.fixture.ids[0]])
        self.assertEqual(self.current(), second)
        self.assertEqual(len(self.stored()), 1)
        self.assert_preserved()

    def test_cas_rejects_stale_new_update_and_missing_existing_revision(self):
        with self.assertRaises(drafts.DraftError) as error: drafts.execute({**self.request, "expectedRevision": 1})
        self.assertEqual(error.exception.code, "draft_conflict")
        first = drafts.execute(self.request)
        for expected in (None, 2):
            with self.assertRaises(drafts.DraftError) as error: drafts.execute({**self.request, "expectedRevision": expected, "caption": "not saved"})
            self.assertEqual(error.exception.code, "draft_conflict")
        self.assertEqual(self.current(), first["draft"])
        updated = drafts.execute({**self.request, "expectedRevision": 1, "caption": "latest"})["draft"]
        with self.assertRaises(drafts.DraftError) as error: drafts.execute({**self.request, "expectedRevision": 1})
        self.assertEqual(error.exception.code, "draft_conflict")
        self.assertEqual(self.current(), updated)
        self.assert_preserved()

    def test_same_post_id_accounts_are_isolated_and_mixing_posts_is_rejected(self):
        key, media_id, _ = self.other_post()
        first = drafts.execute(self.request)["draft"]
        other = drafts.execute({**self.request, "postKey": key, "mediaIds": [media_id], "caption": "다른 계정"})["draft"]
        with self.assertRaises(drafts.DraftError) as error:
            drafts.execute({**self.request, "expectedRevision": 1, "mediaIds": [self.fixture.ids[0], media_id]})
        self.assertEqual(error.exception.code, "draft_media_unavailable")
        self.assertEqual(self.stored(), {("Example", "AbC_01"): first, ("Other", "AbC_01"): other})
        self.assert_preserved()

    def test_invalid_ids_limits_controls_and_revisions_cannot_create_storage(self):
        changes = [{"mediaIds": []}, {"mediaIds": [self.fixture.ids[0]]*2}, {"mediaIds": ["../outside.png"]},
            {"mediaIds": [f"{number:032x}" for number in range(101)]}, {"mediaIds": "a"*32}, {"mediaIds": [None]},
            {"caption": "🙂"*5001}, {"caption": "bad\x00text"}, {"caption": None},
            *({"expectedRevision": value} for value in (True, 0, -1, 1.0, "1", 2**53))]
        for change in changes:
            with self.subTest(change=repr(change)[:60]), self.assertRaises(drafts.DraftError): drafts.execute({**self.request, **change})
        with self.assertRaises(drafts.DraftError) as error: drafts.execute({**self.request, "mediaIds": ["f"*32]})
        self.assertEqual(error.exception.code, "draft_media_unavailable")
        self.assertEqual(self.stored(), {})
        self.assert_preserved()

    def test_unicode_limit_and_exact_outer_whitespace_are_preserved(self):
        caption = "🙂"*4999+"한글"
        self.assertEqual(drafts.execute({**self.request, "caption": caption})["draft"]["caption"], caption)
        self.assertEqual(drafts.execute({**self.request, "expectedRevision": 1, "caption": " \n\t "})["draft"]["caption"], " \n\t ")
        self.assert_preserved()

    def test_missing_media_keeps_draft_ids_and_can_be_removed_by_revision_update(self):
        original = drafts.execute(self.request)["draft"]
        raw = self.fixture.originals[0].read_bytes()
        self.fixture.originals[0].unlink()
        self.assertEqual(self.current(), original)
        with self.assertRaises(drafts.DraftError) as error: drafts.execute({**self.request, "expectedRevision": 1})
        self.assertEqual(error.exception.code, "draft_media_unavailable")
        changed = drafts.execute({**self.request, "expectedRevision": 1, "mediaIds": [self.fixture.ids[1]]})["draft"]
        self.assertEqual(changed["mediaIds"], [self.fixture.ids[1]])
        self.fixture.originals[0].write_bytes(raw)
        self.assert_preserved()

    def test_tampered_file_or_symlink_is_never_adopted_as_saved_selection(self):
        raw = self.fixture.originals[0].read_bytes()
        self.fixture.originals[0].write_bytes(b"tampered")
        with self.assertRaises(drafts.DraftError) as error: drafts.execute(self.request)
        self.assertEqual(error.exception.code, "draft_media_unavailable")
        self.fixture.originals[0].unlink()
        outside = self.fixture.base / "outside.png"
        outside.write_bytes(raw)
        self.fixture.originals[0].symlink_to(outside)
        with self.assertRaises(drafts.DraftError): drafts.execute(self.request)
        self.assertEqual(outside.read_bytes(), raw)
        self.fixture.originals[0].unlink()
        self.fixture.originals[0].write_bytes(raw)
        self.assert_preserved()

    def test_corrupt_draft_rows_warn_without_losing_gallery_or_overwriting_records(self):
        drafts.execute(self.request)
        with closing(sqlite3.connect(self.root / "state/state.db")) as db, db:
            db.execute("UPDATE post_drafts SET media_ids_json='not json'")
        snapshot = self.fixture.snapshot()["snapshot"]
        self.assertIn("drafts_unavailable", [item["code"] for item in snapshot["warnings"]])
        self.assertEqual([item["status"] for item in snapshot["posts"][0]["attachments"]], ["saved", "saved"])
        with self.assertRaises(drafts.DraftError) as error: drafts.execute({**self.request, "expectedRevision": 1})
        self.assertEqual(error.exception.code, "drafts_unavailable")
        with self.assertRaises(deletion.DeleteError) as error: self.prepare_delete()
        self.assertEqual(error.exception.code, "drafts_unavailable")
        with closing(sqlite3.connect(self.root / "state/state.db")) as db:
            self.assertEqual(db.execute("SELECT media_ids_json FROM post_drafts").fetchone()[0], "not json")
        self.assert_preserved()

    def test_corrupt_schema_or_trigger_blocks_writes_and_delete_cascade(self):
        drafts.execute(self.request)
        with closing(sqlite3.connect(self.root / "state/state.db")) as db, db:
            db.execute("CREATE TRIGGER unexpected_draft AFTER DELETE ON post_drafts BEGIN UPDATE jobs SET error_code='changed'; END")
        for operation in (lambda: drafts.execute({**self.request, "expectedRevision": 1}), self.prepare_delete):
            with self.assertRaises((drafts.DraftError, deletion.DeleteError)) as error: operation()
            self.assertEqual(error.exception.code, "drafts_unavailable")
        self.assert_preserved()

    def test_lock_pending_deletion_and_absent_database_are_not_bypassed(self):
        with CollectionLock(self.root):
            lock = (self.root / "_work/collector.lock").read_bytes()
            with self.assertRaises(SourceError): drafts.execute(self.request)
            self.assertEqual((self.root / "_work/collector.lock").read_bytes(), lock)
        journal = self.root / ("_work/delete-"+"f"*32) / "journal.json"
        journal.parent.mkdir()
        journal.write_text("{}")
        with self.assertRaises(StateError) as error: drafts.execute(self.request)
        self.assertEqual(error.exception.code, "deletion_recovery_required")
        source_only = self.fixture.base / "source-only"
        source = source_only / "results/2026/09/threads-2026-09-21.xlsx"
        source.parent.mkdir(parents=True)
        source.write_bytes(self.fixture.source.read_bytes())
        with self.assertRaises(drafts.DraftError) as error: drafts.execute({**self.request, "root": str(source_only)})
        self.assertEqual(error.exception.code, "draft_state_unavailable")
        self.assertFalse((source_only / "state").exists())
        self.assert_preserved()

    def test_cancel_and_write_error_roll_back_draft_and_lazy_table_creation(self):
        actual = drafts.write_draft
        stopped = False
        def writing(*args):
            nonlocal stopped
            value = actual(*args)
            stopped = True
            return value
        with patch.object(drafts, "write_draft", side_effect=writing):
            with self.assertRaises(drafts.DraftError) as error: drafts.execute(self.request, check=lambda: stopped)
        self.assertEqual(error.exception.code, "cancelled")
        with closing(sqlite3.connect(self.root / "state/state.db")) as db:
            self.assertIsNone(db.execute("SELECT 1 FROM sqlite_master WHERE name='post_drafts'").fetchone())
        original = drafts.execute(self.request)["draft"]
        def failing(*args):
            actual(*args)
            raise OSError("storage failure")
        with patch.object(drafts, "write_draft", side_effect=failing):
            with self.assertRaises(OSError): drafts.execute({**self.request, "expectedRevision": 1, "caption": "failed"})
        self.assertEqual(self.current(), original)
        self.assert_preserved()

    def test_referenced_edit_requires_removal_from_draft_before_deletion(self):
        edit = self.edit()
        drafts.execute({**self.request, "mediaIds": [edit, self.fixture.ids[0]]})
        with self.assertRaises(deletion.DeleteError) as error: self.prepare_delete(edit)
        self.assertEqual(error.exception.code, "draft_media_in_use")
        self.assertTrue(self.fixture.edit_path(edit).exists())
        updated = drafts.execute({**self.request, "expectedRevision": 1, "mediaIds": [self.fixture.ids[0]]})["draft"]
        self.assertTrue(deletion.execute(self.prepare_delete(edit))["ok"])
        self.assertFalse(self.fixture.edit_path(edit).exists())
        self.assertEqual(self.current(), updated)
        self.assert_preserved()

    def test_edit_delete_confirmation_cannot_ignore_new_draft_reference(self):
        edit = self.edit()
        prepared = self.prepare_delete(edit)
        drafts.execute({**self.request, "mediaIds": [edit]})
        with self.assertRaises(deletion.DeleteError) as error: deletion.execute(prepared)
        self.assertEqual(error.exception.code, "draft_media_in_use")
        self.assertTrue(self.fixture.edit_path(edit).exists())
        self.assert_preserved()

    def test_post_delete_cascades_only_its_draft_in_the_same_commit(self):
        key, media_id, path = self.other_post()
        drafts.execute(self.request)
        other = drafts.execute({**self.request, "postKey": key, "mediaIds": [media_id], "caption": "keep other"})["draft"]
        self.assertTrue(deletion.execute(self.prepare_delete())["ok"])
        self.assertEqual(self.stored(), {("Other", "AbC_01"): other})
        self.assertTrue(path.exists())
        self.assertTrue(all(not path.exists() for path in self.fixture.originals))
        self.assertEqual(self.fixture.snapshot()["snapshot"]["posts"][0]["key"], key)
        with closing(sqlite3.connect(self.root / "state/state.db")) as db:
            for table, expected in self.before["tables"].items(): self.assertEqual(db.execute(f"SELECT * FROM {table}").fetchall(), expected)
        with self.assertRaises(drafts.DraftError) as error: drafts.execute(self.request)
        self.assertEqual(error.exception.code, "post_missing")

    def test_failed_post_delete_rolls_back_draft_removal_with_tombstone(self):
        original = drafts.execute(self.request)["draft"]
        prepared = self.prepare_delete()
        actual = deletion.apply_tombstone
        def receipt_conflict(root, document): return actual(root, {**document, "id": "0"*32})
        with patch.object(deletion, "apply_tombstone", side_effect=receipt_conflict):
            with self.assertRaises(deletion.DeleteError): deletion.execute(prepared)
        self.assertEqual(self.current(), original)
        self.assert_preserved()

    def test_crash_before_post_delete_commit_recovers_draft_and_originals(self):
        original = drafts.execute(self.request)["draft"]
        self.crash_delete(self.prepare_delete())
        recovered = deletion.execute({"root": str(self.root), "command": "recover"})
        self.assertEqual(recovered["recovered"], 1)
        self.assertEqual(self.current(), original)
        self.assert_preserved()

    def test_crash_after_post_delete_commit_does_not_resurrect_draft(self):
        drafts.execute(self.request)
        self.crash_delete(self.prepare_delete(), after=True)
        recovered = deletion.execute({"root": str(self.root), "command": "recover"})
        self.assertEqual(recovered["recovered"], 1)
        self.assertEqual(self.stored(), {})
        self.assertEqual(self.fixture.snapshot()["snapshot"]["posts"], [])
        self.assertTrue(all(not path.exists() for path in self.fixture.originals))

    def test_cli_isolated_save_conflict_and_sigterm_preserve_committed_revision(self):
        def run(value):
            return subprocess.run([sys.executable, "-I", "-B", drafts.__file__], input=json.dumps(value), text=True, capture_output=True, timeout=15)
        first = run(self.request)
        self.assertEqual(first.returncode, 0, first.stderr+first.stdout)
        saved = json.loads(first.stdout)["draft"]
        self.assertEqual(self.current(), saved)
        stale = run(self.request)
        self.assertEqual(stale.returncode, 1)
        self.assertEqual(json.loads(stale.stdout)["error"]["code"], "draft_conflict")
        code = """
import os,signal,sys
sys.path.insert(0,sys.argv[1])
import post_draft as worker
real=worker.write_draft
def writing(*args):
    result=real(*args)
    os.kill(os.getpid(),signal.SIGTERM)
    return result
worker.write_draft=writing
sys.exit(worker.main())
"""
        cancelled = subprocess.run([sys.executable, "-I", "-B", "-c", code, str(Path(drafts.__file__).parent)],
            input=json.dumps({**self.request, "expectedRevision": 1, "caption": "cancelled"}), text=True, capture_output=True, timeout=15)
        self.assertEqual(cancelled.returncode, 1, cancelled.stderr)
        self.assertEqual(json.loads(cancelled.stdout)["error"]["code"], "cancelled")
        self.assertEqual(self.current(), saved)
        self.assert_preserved()

    def delete_request(self, revision=1):
        return {"root": str(self.root), "postKey": self.fixture.key, "kind": "delete", "expectedRevision": revision}

    def test_delete_registered_draft_preserves_originals_edits_source_and_other_draft(self):
        other_key, other_id, _ = self.other_post()
        edit_id = self.edit()
        drafts.execute({**self.request, "mediaIds": [edit_id, *self.fixture.ids]})
        other = drafts.execute({**self.request, "postKey": other_key, "mediaIds": [other_id]})["draft"]
        media = self.files()
        with patch("socket.create_connection", side_effect=AssertionError("No network")):
            result = drafts.execute(self.delete_request())
        self.assertEqual(result, {"ok": True, "postKey": self.fixture.key, "deleted": True})
        self.assertEqual(self.stored(), {("Other", "AbC_01"): other})
        self.assertEqual(media, self.files())
        self.assertEqual(len(self.fixture.snapshot()["snapshot"]["posts"]), 2)
        self.assert_preserved()

    def test_delete_draft_allows_missing_original_and_selected_edit(self):
        edit_id = self.edit()
        drafts.execute({**self.request, "mediaIds": [edit_id, *self.fixture.ids]})
        self.fixture.originals[0].unlink()
        self.fixture.edit_path(edit_id).unlink()
        media = self.files()
        self.assertTrue(drafts.execute(self.delete_request())["deleted"])
        self.assertEqual(self.stored(), {})
        self.assertEqual(media, self.files())
        self.assertEqual(self.fixture.source.read_bytes(), self.before["source"])
        with closing(sqlite3.connect(self.root / "state/state.db")) as db:
            for name, rows in self.before["tables"].items():
                self.assertEqual(db.execute(f"SELECT * FROM {name}").fetchall(), rows)

    def test_delete_draft_requires_existing_exact_revision_and_rejects_extra_fields(self):
        with self.assertRaises(drafts.DraftError) as error: drafts.execute(self.delete_request())
        self.assertEqual(error.exception.code, "draft_conflict")
        original = drafts.execute(self.request)["draft"]
        for revision in (None, False, 0, -1, 1.5, 2):
            with self.subTest(revision=revision), self.assertRaises(drafts.DraftError):
                drafts.execute(self.delete_request(revision))
        with self.assertRaises(drafts.DraftError): drafts.execute({**self.delete_request(), "mediaIds": self.fixture.ids})
        self.assertEqual(self.current(), original)
        self.assert_preserved()

    def test_delete_draft_respects_lock_pending_journal_and_corrupt_schema(self):
        drafts.execute(self.request)
        with CollectionLock(self.root):
            with self.assertRaises(SourceError): drafts.execute(self.delete_request())
        journal = self.root / ("_work/delete-" + "f"*32) / "journal.json"
        journal.parent.mkdir()
        journal.write_text("{}")
        with self.assertRaises(StateError): drafts.execute(self.delete_request())
        journal.unlink()
        journal.parent.rmdir()
        with closing(sqlite3.connect(self.root / "state/state.db")) as db, db:
            db.execute("CREATE TRIGGER unsafe_draft AFTER DELETE ON post_drafts BEGIN DELETE FROM jobs; END")
        with self.assertRaises(drafts.DraftError) as error: drafts.execute(self.delete_request())
        self.assertEqual(error.exception.code, "drafts_unavailable")
        with closing(sqlite3.connect(self.root / "state/state.db")) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM post_drafts").fetchone()[0], 1)
        self.assert_preserved()

    def test_delete_draft_cancel_and_failure_after_sql_roll_back(self):
        original = drafts.execute(self.request)["draft"]
        actual = drafts.delete_draft
        stopped = False
        def deleting(*args):
            nonlocal stopped
            actual(*args)
            stopped = True
        with patch.object(drafts, "delete_draft", side_effect=deleting), self.assertRaises(drafts.DraftError) as error:
            drafts.execute(self.delete_request(), check=lambda: stopped)
        self.assertEqual(error.exception.code, "cancelled")
        self.assertEqual(self.current(), original)
        def failing(*args):
            actual(*args)
            raise OSError("failed after delete")
        with patch.object(drafts, "delete_draft", side_effect=failing), self.assertRaises(OSError):
            drafts.execute(self.delete_request())
        self.assertEqual(self.current(), original)
        self.assert_preserved()

    def test_cli_delete_receipt_and_repeat_conflict(self):
        drafts.execute(self.request)
        for expected_code in (0, 1):
            result = subprocess.run([sys.executable, "-I", "-B", drafts.__file__],
                input=json.dumps(self.delete_request()), text=True, capture_output=True, timeout=15)
            self.assertEqual(result.returncode, expected_code, result.stderr + result.stdout)
            parsed = json.loads(result.stdout)
            self.assertEqual(parsed["deleted"] if expected_code == 0 else parsed["error"]["code"], True if expected_code == 0 else "draft_conflict")
        self.assert_preserved()

    def export_request(self, revision=1):
        return {"root": str(self.root), "postKey": self.fixture.key,
            "destination": str(self.fixture.base / "AbC_01.zip"), "expectedRevision": revision}

    def test_draft_zip_uses_selected_reverse_order_edit_and_caption_with_original_metadata(self):
        edit_id = self.edit()
        drafts.execute({**self.request, "mediaIds": [edit_id, self.fixture.ids[1]]})
        media = self.files()
        db_before = (self.root / "state/state.db").read_bytes()
        result = fixtures.export_post.export_post(self.export_request())
        self.assertEqual(result, {"ok": True, "fileName": "AbC_01.zip"})
        with zipfile.ZipFile(self.export_request()["destination"]) as archive:
            self.assertEqual(archive.namelist(), ["01.png", "02.mp4", "게시글정보.txt"])
            self.assertEqual(archive.read("01.png"), self.fixture.edit_path(edit_id).read_bytes())
            self.assertEqual(archive.read("02.mp4"), self.fixture.originals[1].read_bytes())
            self.assertEqual(archive.read("게시글정보.txt").decode(),
                "계정명: @Example\n수집일: 2026-09-21 12:00:00 KST\n"
                "원문 주소: https://www.threads.com/@example/post/AbC_01\n\n캡션\n" + self.request["caption"])
        self.assertEqual(media, self.files())
        self.assertEqual(db_before, (self.root / "state/state.db").read_bytes())
        self.assert_preserved()

    def test_draft_zip_does_not_require_unselected_media_and_preserves_empty_caption(self):
        drafts.execute({**self.request, "caption": "", "mediaIds": [self.fixture.ids[1]]})
        self.fixture.originals[0].unlink()
        self.assertTrue(fixtures.export_post.export_post(self.export_request())["ok"])
        with zipfile.ZipFile(self.export_request()["destination"]) as archive:
            self.assertEqual(archive.namelist(), ["01.mp4", "게시글정보.txt"])
            self.assertTrue(archive.read("게시글정보.txt").decode().endswith("캡션\n"))

    def test_draft_zip_stale_revision_or_missing_selected_media_preserves_destination(self):
        drafts.execute(self.request)
        destination = Path(self.export_request()["destination"])
        destination.write_bytes(b"keep")
        for revision in (None, False, 0, 2):
            with self.subTest(revision=revision), self.assertRaises(fixtures.export_post.ExportError):
                fixtures.export_post.export_post(self.export_request(revision))
        self.fixture.originals[1].unlink()
        with self.assertRaises(fixtures.export_post.ExportError) as error:
            fixtures.export_post.export_post(self.export_request())
        self.assertEqual(error.exception.code, "attachments_incomplete")
        self.assertEqual(destination.read_bytes(), b"keep")
        self.assertEqual(list(self.fixture.base.glob(".threads-export-*")), [])

    def test_draft_zip_concurrent_caption_update_aborts_without_stale_publish(self):
        drafts.execute(self.request)
        destination = Path(self.export_request()["destination"])
        destination.write_bytes(b"keep")
        actual = fixtures.export_post.copy_media
        changed = False
        def change_draft(*args):
            nonlocal changed
            result = actual(*args)
            if not changed:
                drafts.execute({**self.request, "expectedRevision": 1, "caption": "new revision"})
                changed = True
            return result
        with patch.object(fixtures.export_post, "copy_media", side_effect=change_draft), self.assertRaises(fixtures.export_post.ExportError) as error:
            fixtures.export_post.export_post(self.export_request())
        self.assertEqual(error.exception.code, "source_changed")
        self.assertEqual(destination.read_bytes(), b"keep")
        self.assertEqual(self.current()["revision"], 2)
        self.assert_preserved()


if __name__ == "__main__": unittest.main()
