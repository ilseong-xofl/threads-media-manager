"""Local imports preserve external sources and integrate with draft/file lifecycle."""
from contextlib import closing
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
import uuid
from unittest.mock import patch
import zipfile

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "local-runtime"))
import collection_view as view
import delete_media
import export_post
import library_maintenance as maintenance
import local_post
import post_draft
from threads_runner import inspection, source_cleanup
from threads_runner.state import State, StateError
from threads_source.files import SourceError


class LocalPostTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.root = self.base / "개인 작업"
        self.root.mkdir()
        self.source = self.base / "외부 원본.png"
        Image.new("RGB", (16, 12), (30, 80, 160)).save(self.source)
        self.raw = self.source.read_bytes()
        self.request = {"root": str(self.root), "postId": uuid.uuid4().hex, "caption": "직접 쓴 캡션\n🙂", "files": [self.record(self.source)]}

    def record(self, path, kind="image"):
        raw = path.read_bytes()
        return {"path": str(path), "mediaId": uuid.uuid4().hex, "kind": kind, "size": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}

    def snapshot(self):
        return view.read_snapshot(self.root)

    def create(self):
        return local_post.execute(self.request)

    def backup(self, path):
        return maintenance.execute({"command": "backup", "root": str(self.root), "path": str(path)})

    def restore(self, path):
        return maintenance.execute({"command": "restore", "root": str(self.root), "path": str(path)})

    def test_empty_library_registers_owned_copy_and_no_download_history(self):
        with patch("socket.create_connection", side_effect=AssertionError("No network")):
            result = self.create()
        self.assertEqual(json.loads(result["postKey"]), [":local:", self.request["postId"]])
        snapshot = self.snapshot()
        post = snapshot["snapshot"]["posts"][0]
        self.assertEqual(post["origin"], "local")
        self.assertTrue(post["downloadExcluded"])
        self.assertNotIn("sourceDeleted", post)
        self.assertEqual(post["reasons"], [])
        self.assertEqual(post["draft"], result["draft"])
        self.assertEqual(post["attachments"][0]["status"], "saved")
        self.assertEqual(snapshot["snapshot"]["sourceCount"], 0)
        self.assertEqual(self.source.read_bytes(), self.raw)
        self.assertEqual((self.root / snapshot["files"][0]["relativePath"]).read_bytes(), self.raw)
        with closing(sqlite3.connect(self.root / "state/state.db")) as db:
            for table in ("media", "jobs", "requests"):
                self.assertEqual(db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0], 0)
        self.assertEqual(self.create(), result)
        self.assertFalse((self.root / "_work/collector.lock").exists())

    def test_edit_export_delete_removes_only_owned_copy_and_leaves_tombstone(self):
        result = self.create()
        copied = self.root / self.snapshot()["files"][0]["relativePath"]
        changed = post_draft.execute({"root": str(self.root), "postKey": result["postKey"], "expectedRevision": 1,
            "caption": "수정한 직접 캡션", "mediaIds": result["draft"]["mediaIds"]})
        archive = self.base / "개인.zip"
        export_post.export_post({"root": str(self.root), "postKey": result["postKey"], "expectedRevision": 2, "destination": str(archive)})
        with zipfile.ZipFile(archive) as zipped:
            text = zipped.read("게시글정보.txt").decode()
            self.assertIn("구분: 개인 등록", text)
            self.assertIn("수정한 직접 캡션", text)
            self.assertNotIn("@:local:", text)
        deleted = post_draft.execute({"root": str(self.root), "postKey": result["postKey"], "kind": "delete", "expectedRevision": changed["draft"]["revision"]})
        self.assertTrue(deleted["deleted"])
        self.assertFalse(copied.exists())
        self.assertEqual(self.snapshot()["snapshot"]["posts"], [])
        self.assertEqual(self.source.read_bytes(), self.raw)
        with self.assertRaises(local_post.LocalPostError) as error:
            self.create()
        self.assertEqual(error.exception.code, "local_post_conflict")

    def test_validation_failure_rolls_back_whole_import(self):
        invalid = self.base / "broken.png"
        invalid.write_bytes(b"not an image")
        self.request["files"].append(self.record(invalid))
        with self.assertRaises(local_post.LocalPostError):
            self.create()
        self.assertEqual(list((self.root / "media/files").rglob("*.png")), [])
        self.assertEqual(self.snapshot()["snapshot"]["posts"], [])
        self.assertEqual(self.source.read_bytes(), self.raw)

    def test_hash_change_and_symlink_rejected_without_registered_post(self):
        self.request["files"][0]["sha256"] = "0"*64
        with self.assertRaises(local_post.LocalPostError):
            self.create()
        self.assertEqual(self.snapshot()["snapshot"]["posts"], [])
        self.request["files"][0]["sha256"] = hashlib.sha256(self.raw).hexdigest()
        link = self.base / "link.png"
        try:
            link.symlink_to(self.source)
        except OSError:
            self.skipTest("Symbolic links unavailable")
        self.request["files"][0]["path"] = str(link)
        with self.assertRaises(SourceError):
            self.create()

    def test_cancel_during_copy_cleans_partial_without_touching_existing_files(self):
        real = local_post.copy_verified
        def copy(item, path, check, on_create=None):
            real(item, path, lambda: True, on_create)
        with patch.object(local_post, "copy_verified", side_effect=copy):
            with self.assertRaises(local_post.LocalPostError) as error:
                self.create()
        self.assertEqual(error.exception.code, "cancelled")
        self.assertEqual(list((self.root / "media/files").rglob("*.png")), [])
        self.assertEqual(self.source.read_bytes(), self.raw)

    def test_hard_crash_before_commit_recovers_only_journal_owned_copies(self):
        code = """
import json,os,sys
sys.path.insert(0,sys.argv[1])
import local_post
real=local_post.post_draft.write_draft
def crash(*args):
    real(*args)
    os._exit(92)
local_post.post_draft.write_draft=crash
local_post.execute(json.loads(sys.argv[2]))
"""
        result = subprocess.run([sys.executable, "-I", "-B", "-c", code, str(Path(local_post.__file__).parent), json.dumps(self.request)], capture_output=True, timeout=20)
        self.assertEqual(result.returncode, 92, result.stderr)
        with self.assertRaises(SourceError) as error:
            self.snapshot()
        self.assertEqual(error.exception.code, "local_post_recovery_required")
        self.assertEqual(local_post.recover(self.root)["recovered"], 1)
        self.assertEqual(list((self.root / "media/files").rglob("*.png")), [])
        self.assertEqual(self.snapshot()["snapshot"]["posts"], [])
        self.assertEqual(self.source.read_bytes(), self.raw)
        self.assertTrue(self.create()["ok"])

    def test_hard_crash_after_commit_preserves_saved_draft_and_copy(self):
        code = """
import json,os,sys
sys.path.insert(0,sys.argv[1])
import local_post
real=local_post.recover_imports
calls=0
def crash(*args):
    global calls
    calls+=1
    if calls==2: os._exit(93)
    return real(*args)
local_post.recover_imports=crash
local_post.execute(json.loads(sys.argv[2]))
"""
        result = subprocess.run([sys.executable, "-I", "-B", "-c", code, str(Path(local_post.__file__).parent), json.dumps(self.request)], capture_output=True, timeout=20)
        self.assertEqual(result.returncode, 93, result.stderr)
        self.assertEqual(local_post.recover(self.root)["recovered"], 1)
        snapshot = self.snapshot()
        self.assertEqual(snapshot["snapshot"]["posts"][0]["draft"]["caption"], self.request["caption"])
        self.assertEqual((self.root / snapshot["files"][0]["relativePath"]).read_bytes(), self.raw)
        self.assertEqual(self.create()["draft"]["revision"], 1)

    def test_hard_crash_between_link_and_unlink_cleans_both_owned_names(self):
        code = """
import json,os,sys
sys.path.insert(0,sys.argv[1])
import local_post
real=local_post.os.link
def crash(*args):
    real(*args)
    os._exit(94)
local_post.os.link=crash
local_post.execute(json.loads(sys.argv[2]))
"""
        result = subprocess.run([sys.executable, "-I", "-B", "-c", code, str(Path(local_post.__file__).parent), json.dumps(self.request)], capture_output=True, timeout=20)
        self.assertEqual(result.returncode, 94, result.stderr)
        self.assertEqual(local_post.recover(self.root)["recovered"], 1)
        self.assertEqual(list((self.root / "media/files").rglob("*.png")), [])
        self.assertTrue(self.create()["ok"])

    def test_limits_invalid_video_and_duplicate_identifiers_rejected(self):
        for value in (0, 32*1024**2+1):
            request = {**self.request, "files": [{**self.request["files"][0], "size": value}]}
            with self.assertRaises(local_post.LocalPostError):
                local_post.execute(request)
        with self.assertRaises(local_post.LocalPostError):
            local_post.execute({**self.request, "files": self.request["files"]*2})
        with self.assertRaises(local_post.LocalPostError):
            local_post.execute({**self.request, "files": self.request["files"]*101})
        video = self.base / "fake.mp4"
        video.write_bytes(b"not a video")
        with self.assertRaises(local_post.LocalPostError):
            local_post.execute({**self.request, "files": [self.record(video, "video")]})

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg unavailable")
    def test_mixed_image_video_order_and_real_video_validation(self):
        video = self.base / "video.mp4"
        subprocess.run([shutil.which("ffmpeg"), "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=16x16:d=0.15", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(video)], check=True, capture_output=True, timeout=15)
        self.request["files"].insert(0, self.record(video, "video"))
        result = self.create()
        self.assertEqual([item["kind"] for item in self.snapshot()["snapshot"]["posts"][0]["attachments"]], ["video", "image"])
        self.assertEqual(result["draft"]["mediaIds"], [item["mediaId"] for item in self.request["files"]])

    def test_backup_restore_and_transfer_keep_personal_posts_and_external_source(self):
        created = self.create()
        backup = self.base / "saved.sqlite"
        self.backup(backup)
        post_draft.execute({"root": str(self.root), "postKey": created["postKey"], "expectedRevision": 1,
            "caption": "changed", "mediaIds": created["draft"]["mediaIds"]})
        self.restore(backup)
        self.assertEqual(self.snapshot()["snapshot"]["posts"][0]["draft"]["caption"], self.request["caption"])
        moved = self.base / "new computer"
        shutil.copytree(self.root, moved)
        (moved / "state/state.db").unlink()
        result = maintenance.execute({"command": "restore", "root": str(moved), "path": str(backup)})
        self.assertEqual(result["restore_mode"], "full")
        moved_snapshot = view.read_snapshot(moved)
        self.assertEqual(moved_snapshot["snapshot"]["posts"][0]["origin"], "local")
        self.assertEqual((moved / moved_snapshot["files"][0]["relativePath"]).read_bytes(), self.raw)
        self.assertEqual(self.source.read_bytes(), self.raw)

    def test_restore_preserves_new_local_posts_and_never_resurrects_deleted(self):
        first = self.create()
        backup = self.base / "saved.sqlite"
        self.backup(backup)
        second = local_post.execute({**self.request, "postId": uuid.uuid4().hex, "files": [self.record(self.source)]})
        self.restore(backup)
        posts = self.snapshot()["snapshot"]["posts"]
        self.assertEqual({item["key"] for item in posts}, {first["postKey"], second["postKey"]})
        revision = next(item["draft"]["revision"] for item in posts if item["key"] == first["postKey"])
        post_draft.execute({"root": str(self.root), "postKey": first["postKey"], "kind": "delete", "expectedRevision": revision})
        self.restore(backup)
        self.assertEqual([item["key"] for item in self.snapshot()["snapshot"]["posts"]], [second["postKey"]])

    def test_healthy_restore_can_merge_missing_local_metadata_from_matching_copies(self):
        self.create()
        backup = self.base / "saved.sqlite"
        self.backup(backup)
        with closing(sqlite3.connect(self.root / "state/state.db")) as db, db:
            db.execute("DELETE FROM post_drafts")
            db.execute("DROP TABLE local_post_media")
            db.execute("DROP TABLE local_posts")
        self.restore(backup)
        self.assertEqual(len(self.snapshot()["snapshot"]["posts"]), 1)

    def test_lost_database_with_existing_media_is_never_reinitialized(self):
        self.create()
        (self.root / "state/state.db").unlink()
        with self.assertRaises(StateError):
            self.create()
        self.assertFalse((self.root / "state/state.db").exists())

    def test_missing_local_copy_remains_editable_without_blocking_collection_downloads(self):
        self.create()
        (self.root / self.snapshot()["files"][0]["relativePath"]).unlink()
        post = self.snapshot()["snapshot"]["posts"][0]
        self.assertEqual(post["attachments"][0]["status"], "review")
        status = inspection.read_status(self.root)
        self.assertIsNone(status["problem"])
        self.assertEqual(status["links"], {})
        self.assertIsNone(source_cleanup.clean(self.root)["problem"])


if __name__ == "__main__":
    unittest.main()
