"""A copied complete folder works on the destination PC without redownloading."""
from contextlib import closing
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

import test_batch_download as fixtures
import collection_view
import library_maintenance
import post_draft
import save_post_comment


class LibraryTransferTests(unittest.TestCase):
    def transferred_library(self, *, full, windows_root=False):
        fx = fixtures.BatchDownloadTests()
        fx.setUp()
        self.addCleanup(fx.tearDown)
        fx.fixture([("alpha", [2])])
        self.assertIsNone(fx.run_batch()["problem"])
        original = fx.root
        with closing(sqlite3.connect(original / "state/state.db")) as db:
            ids = [row[0] for row in db.execute("SELECT media_id FROM media ORDER BY ordinal")]
        key = '["alpha","alpha_000"]'
        post_draft.execute({"root": str(original), "postKey": key, "caption": "moved caption", "mediaIds": ids, "expectedRevision": None})
        save_post_comment.execute({"root": str(original), "postKey": key, "caption": "moved reply", "link": ""})
        destination = tempfile.TemporaryDirectory()
        self.addCleanup(destination.cleanup)
        base = Path(destination.name).resolve()
        backup = base / "이전 백업.sqlite"
        library_maintenance.execute({"command": "backup", "root": str(original), "path": str(backup)})
        original_hashes = fx.hashes()
        copied = base / "새 PC 자료"
        shutil.copytree(original, copied)
        fx.root = copied
        fx.book = copied / fx.book.relative_to(original)
        db_path = copied / "state/state.db"
        if full:
            db_path.unlink()
        if windows_root:
            with closing(sqlite3.connect(backup if full else db_path)) as db, db:
                db.execute("UPDATE meta SET value=? WHERE key='root'", (json.dumps(r"C:\Users\Member\Downloads\자료"),))
        with patch("socket.create_connection", side_effect=AssertionError("No network during relocation")):
            # Both direct restore and folder selection work on a different path.
            if full:
                result = library_maintenance.execute({"command": "restore", "root": str(copied), "path": str(backup)})
                self.assertEqual(result["restore_mode"], "full")
                self.assertFalse(result["history_review_required"])
                library_maintenance.execute({"command": "reconnect", "root": str(copied)})
            else:
                result = library_maintenance.execute({"command": "restore", "root": str(copied), "path": str(backup)})
                self.assertEqual(result["restore_mode"], "metadata")
            view = collection_view.read_snapshot(copied)["snapshot"]
        post = view["posts"][0]
        self.assertTrue(all(item["status"] == "saved" for item in post["attachments"]))
        self.assertEqual(post["draft"]["caption"], "moved caption")
        self.assertEqual(post["draft"]["mediaIds"], ids)
        self.assertEqual(post["comment"]["caption"], "moved reply")
        self.assertIsNone(fx.meta("stop"))
        self.assertEqual(fx.meta("root"), str(copied))
        self.assertEqual(fx.meta("next_allowed"), fx.completions[-1] + 60)
        self.assertEqual(fx.book.read_bytes(), (original / fx.book.relative_to(copied)).read_bytes())
        old_files = {p.relative_to(copied): hashlib.sha256(p.read_bytes()).hexdigest()
                     for p in (copied / "media").rglob("*") if p.is_file()}
        # A normal download action finds nothing to fetch from the moved posts.
        def no_transfer(*args, **kwargs): self.fail("Existing media was downloaded again")
        self.assertIsNone(fx.run_batch(transfer=no_transfer)["problem"])
        self.assertEqual(len(fx.requests), 2)
        # Future newly collected media remains downloadable using the normal button.
        fx.fixture([("alpha", [2, 1])])
        self.assertIsNone(fx.run_batch()["problem"])
        self.assertEqual(len(fx.requests), 3)
        self.assertIn("alpha_001-1.jpg", fx.requests[-1]["url"])
        self.assertTrue(all(hashlib.sha256((copied / p).read_bytes()).hexdigest() == digest
                            for p, digest in old_files.items()))
        fx.root = original
        self.assertEqual(fx.hashes(), original_hashes)

    def test_copied_folder_and_database_restore_preserve_files_and_future_downloads(self):
        self.transferred_library(full=False)

    def test_new_pc_full_restore_uses_existing_files_and_allows_only_new_downloads(self):
        self.transferred_library(full=True)

    def test_backup_from_windows_can_be_rebound_on_another_operating_system(self):
        self.transferred_library(full=True, windows_root=True)

    def test_copied_windows_database_can_be_restored_directly_at_a_new_path(self):
        self.transferred_library(full=False, windows_root=True)


if __name__ == "__main__": unittest.main()
