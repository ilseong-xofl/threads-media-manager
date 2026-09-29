"""Shared file retention and last-reference deletion, using synthetic libraries only."""
from contextlib import closing
import hashlib
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import unittest
from unittest.mock import patch
import zipfile

import test_media_edit as fixtures
from test_ai_media import generation
from test_collection_source import payload, workbook
import delete_media as deletion
import post_draft as drafts
import save_post_comment as comments
from threads_runner import deletion_state


class IndependentDeletionTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.MediaEditTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.root = self.fixture.root
        self.request = {"root": str(self.root), "postKey": self.fixture.key,
                        "caption": "Registered caption", "mediaIds": list(self.fixture.ids), "expectedRevision": None}
        self.source_request = {"root": str(self.root), "postKey": self.fixture.key, "kind": "post", "command": "prepare"}

    def source_delete(self):
        prepared = deletion.execute(self.source_request)
        deletion.execute({**self.source_request, "command": "commit", "fingerprint": prepared["fingerprint"]})
        return prepared

    def draft_delete(self, *, hidden=False, revision=1):
        return {"root": str(self.root), "postKey": self.fixture.key, "kind": "delete",
                "expectedRevision": revision, "expectedSourceDeleted": hidden}

    def post(self):
        return self.fixture.snapshot()["snapshot"]["posts"][0]

    def files(self):
        return {path.relative_to(self.root).as_posix(): path.read_bytes() for base in ("media", "ai-drafts")
                for path in (self.root / base).rglob("*") if path.is_file()}

    def crash(self, request, *, after=False, legacy=False):
        code = """
import json,os,sys
sys.path.insert(0,sys.argv[1])
import delete_media as d
import post_draft
request=json.loads(sys.argv[2])
if sys.argv[4]=='legacy':
    prepare=d.prepare_journal
    def legacy(*args):
        folder,document=prepare(*args)
        document.pop('disposition')
        document.pop('expectedRevision')
        d.write_atomic(folder/'journal.json',d.encoded(document))
        return folder,document
    d.prepare_journal=legacy
actual=d.apply_tombstone
def crash(*args):
    if sys.argv[3]=='after': actual(*args)
    os._exit(93)
d.apply_tombstone=crash
(post_draft if request.get('kind')=='delete' else d).execute(request)
"""
        result = subprocess.run([sys.executable, "-I", "-B", "-c", code,
                                 str(Path(deletion.__file__).parent), json.dumps(request),
                                 "after" if after else "before", "legacy" if legacy else "current"],
                                capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 93, result.stdout+result.stderr)
        self.assertTrue(deletion_state.deletion_pending(self.root))

    def test_source_first_preserves_every_file_and_comment_until_last_registration_is_removed(self):
        edit = fixtures.editor.execute(self.fixture.request)["mediaId"]
        drafts.execute({**self.request, "mediaIds": [self.fixture.ids[0], edit]})
        comment = comments.execute({"root": str(self.root), "postKey": self.fixture.key,
                                    "caption": "Saved comment", "link": "https://example.test/product"})["comment"]
        before = self.files()
        prepared = self.source_delete()
        self.assertEqual((prepared["disposition"], prepared["fileCount"], prepared["editCount"]), ("source_only", 0, 0))
        self.assertEqual(self.files(), before)
        self.assertEqual(self.post()["comment"], comment)
        self.assertTrue(self.post()["sourceDeleted"])
        self.assertEqual(set(self.post()["draft"]["mediaIds"]), {self.fixture.ids[0], edit})
        with patch("socket.create_connection", side_effect=AssertionError("No network")):
            result = drafts.execute(self.draft_delete(hidden=True))
        self.assertTrue(result["deleted"])
        self.assertEqual(self.fixture.snapshot()["snapshot"]["posts"], [])
        self.assertEqual(self.fixture.snapshot()["files"], [])
        self.assertTrue(all(not (self.root / name).exists() for name in before if name != "media/.library.json"))
        self.assertFalse(deletion_state.deletion_pending(self.root))

    def test_registration_first_preserves_files_then_unregistered_source_deletion_purges(self):
        drafts.execute(self.request)
        before = self.files()
        source = self.fixture.source.read_bytes()
        self.assertTrue(drafts.execute(self.draft_delete())["deleted"])
        self.assertNotIn("draft", self.post())
        self.assertEqual(before, self.files())
        self.assertEqual(source, self.fixture.source.read_bytes())
        self.assertEqual(self.source_delete()["disposition"], "purge")
        self.assertTrue(all(not path.exists() for path in self.fixture.originals))
        self.assertEqual(self.fixture.snapshot()["snapshot"]["posts"], [])

    def test_hidden_source_keeps_unselected_third_original_available_for_edit_and_export(self):
        third_id = "e"*32
        data = payload()
        data["posts"][0].update({"이미지 수": 2, "영상 수": 1})
        data["media"].extend([{**data["media"][0], "순서": 2, "종류": "video"},
                              {**data["media"][0], "순서": 3, "종류": "image"}])
        workbook(self.fixture.source, {"게시글": data["posts"], "미디어": data["media"], "실행기록": [data["run"]]})
        path = self.fixture.originals[0].with_name(third_id+".png")
        path.write_bytes(self.fixture.raw_image)
        with closing(sqlite3.connect(self.root / "state/state.db")) as db, db:
            db.row_factory = sqlite3.Row
            row = dict(db.execute("SELECT * FROM jobs WHERE media_id=?", (self.fixture.ids[0],)).fetchone())
            row.update(job_id="f"*32, media_id=third_id, final_rel=path.relative_to(self.root).as_posix())
            db.execute("INSERT INTO media VALUES(?,?,?,?,?)", (third_id, "Example", "AbC_01", 3, "image"))
            db.execute(f"INSERT INTO jobs({','.join(row)}) VALUES({','.join('?' for _ in row)})", tuple(row.values()))
        drafts.execute(self.request)
        before = self.files()
        self.source_delete()
        self.assertEqual(len(self.post()["attachments"]), 3)
        self.assertEqual(len(self.post()["draft"]["mediaIds"]), 2)
        updated = drafts.execute({**self.request, "expectedRevision": 1,
                                  "mediaIds": [third_id, self.fixture.ids[1]]})["draft"]
        self.assertEqual(updated["mediaIds"], [third_id, self.fixture.ids[1]])
        destination = self.fixture.base / "retained.zip"
        fixtures.export_post.export_post({"root": str(self.root), "postKey": self.fixture.key,
                                         "destination": str(destination), "expectedRevision": 2})
        with zipfile.ZipFile(destination) as archive:
            self.assertEqual(archive.read("01.png"), self.fixture.raw_image)
            self.assertEqual(archive.read("02.mp4"), self.fixture.originals[1].read_bytes())
        self.assertEqual(before, self.files())
        self.assertTrue(self.post()["sourceDeleted"])

    def test_stale_confirmation_and_repeated_source_delete_cannot_escalate_to_purge(self):
        drafts.execute(self.request)
        stale_draft = self.draft_delete()
        prepared = deletion.execute(self.source_request)
        self.source_delete()
        before = self.files()
        for data in (stale_draft, {key: value for key, value in stale_draft.items() if key != "expectedSourceDeleted"}):
            with self.assertRaises(drafts.DraftError) as error: drafts.execute(data)
            self.assertEqual(error.exception.code, "draft_conflict")
        for request in (self.source_request, {**self.source_request, "command": "commit", "fingerprint": prepared["fingerprint"]}):
            with self.assertRaises(deletion.DeleteError) as error: deletion.execute(request)
            self.assertEqual(error.exception.code, "post_missing")
        self.assertEqual(before, self.files())
        self.assertEqual(self.post()["draft"]["revision"], 1)

    def test_changed_draft_after_source_confirmation_invalidates_the_whole_delete_plan(self):
        drafts.execute(self.request)
        prepared = deletion.execute(self.source_request)
        drafts.execute({**self.request, "expectedRevision": 1, "caption": "new approved caption"})
        before = self.files()
        with self.assertRaises(deletion.DeleteError) as error:
            deletion.execute({**self.source_request, "command": "commit", "fingerprint": prepared["fingerprint"]})
        self.assertEqual(error.exception.code, "deletion_changed")
        self.assertFalse(self.post().get("sourceDeleted", False))
        self.assertEqual(before, self.files())

    def test_source_hide_does_not_hash_or_delete_changed_media(self):
        drafts.execute(self.request)
        self.fixture.originals[0].write_bytes(b"externally changed; preserve")
        before = self.files()
        with patch.object(deletion, "file_record", side_effect=AssertionError("No media deletion inspection")):
            self.source_delete()
        self.assertEqual(before, self.files())
        self.assertTrue(self.post()["sourceDeleted"])

    def test_final_purge_rolls_back_files_and_keeps_registration_if_db_commit_fails(self):
        drafts.execute(self.request)
        self.source_delete()
        before = self.files()
        actual = deletion.apply_tombstone
        def fail(root, document): return actual(root, {**document, "id": "0"*32})
        with patch.object(deletion, "apply_tombstone", side_effect=fail), self.assertRaises(deletion.DeleteError):
            drafts.execute(self.draft_delete(hidden=True))
        self.assertEqual(before, self.files())
        self.assertIn("draft", self.post())
        self.assertFalse(deletion_state.deletion_pending(self.root))

    def test_last_reference_crash_before_commit_restores_files_and_registration(self):
        drafts.execute(self.request)
        self.source_delete()
        before = self.files()
        self.crash(self.draft_delete(hidden=True))
        self.assertEqual(deletion.execute({"root": str(self.root), "command": "recover"})["recovered"], 1)
        self.assertEqual(before, self.files())
        self.assertIn("draft", self.post())
        self.assertTrue(self.post()["sourceDeleted"])

    def test_last_reference_crash_after_commit_finishes_purge_without_resurrection(self):
        drafts.execute(self.request)
        self.source_delete()
        self.crash(self.draft_delete(hidden=True), after=True)
        self.assertEqual(deletion.execute({"root": str(self.root), "command": "recover"})["recovered"], 1)
        self.assertEqual(self.fixture.snapshot()["snapshot"]["posts"], [])
        self.assertTrue(all(not path.exists() for path in self.fixture.originals))

    def test_legacy_committed_journal_without_disposition_still_recovers_as_full_deletion(self):
        prepared = deletion.execute(self.source_request)
        self.crash({**self.source_request, "command": "commit", "fingerprint": prepared["fingerprint"]}, after=True, legacy=True)
        self.assertEqual(deletion.execute({"root": str(self.root), "command": "recover"})["recovered"], 1)
        self.assertEqual(self.fixture.snapshot()["snapshot"]["posts"], [])
        self.assertTrue(all(not path.exists() for path in self.fixture.originals))

    def test_ai_generations_and_metadata_remain_until_final_purge_without_touching_unknown_files(self):
        ai_path, identifier = generation(self.fixture, caption="AI caption")
        (ai_path / "caption.txt").write_bytes(b"AI caption\n")
        (ai_path.parent / "latest.json").write_text(json.dumps({"id": ai_path.name}))
        unknown = ai_path.parent / "private-notes.txt"
        unknown.write_bytes(b"unowned")
        pending = ai_path.parent / (".pending-"+"a"*32)
        pending.mkdir()
        (pending / "01.png").write_bytes(b"incomplete preserve")
        drafts.execute({**self.request, "mediaIds": [identifier]}, include_ai=True)
        before = self.files()
        self.source_delete()
        self.assertEqual(before, self.files())
        self.assertTrue(drafts.execute(self.draft_delete(hidden=True), include_ai=True)["deleted"])
        self.assertFalse(ai_path.exists())
        self.assertFalse((ai_path.parent / "latest.json").exists())
        self.assertEqual(unknown.read_bytes(), b"unowned")
        self.assertEqual((pending / "01.png").read_bytes(), b"incomplete preserve")

    def test_ai_changed_or_foreign_generation_blocks_purge_and_preserves_all_files(self):
        ai_path, _identifier = generation(self.fixture)
        drafts.execute(self.request)
        self.source_delete()
        (ai_path / "01.png").write_bytes(b"changed generated image")
        before = self.files()
        with self.assertRaises(deletion.DeleteError): drafts.execute(self.draft_delete(hidden=True))
        self.assertEqual(before, self.files())
        self.assertIn("draft", self.post())
        (ai_path / "01.png").write_bytes(self.fixture.raw_image)
        manifest = json.loads((ai_path / "draft.json").read_text())
        manifest["mediaIds"] = ["f"*32]
        (ai_path / "draft.json").write_text(json.dumps(manifest))
        before = self.files()
        with self.assertRaises(deletion.DeleteError): drafts.execute(self.draft_delete(hidden=True))
        self.assertEqual(before, self.files())


if __name__ == "__main__": unittest.main()
