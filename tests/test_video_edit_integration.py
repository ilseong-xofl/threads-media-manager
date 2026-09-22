"""Synthetic MP4 edit integration across lookup, lineage, ZIP, and deletion."""
import base64
from contextlib import closing
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
import unittest
import zipfile

import test_media_edit as fixtures
import delete_media as deletion
import edit_schema
from threads_runner import inspection


class VideoEditIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ffmpeg, cls.ffprobe = shutil.which("ffmpeg"), shutil.which("ffprobe")
        if not cls.ffmpeg or not cls.ffprobe:
            raise unittest.SkipTest("Local ffmpeg and ffprobe are required")
        cls.temp_video = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temp_video.cleanup)
        path = Path(cls.temp_video.name) / "synthetic.mp4"
        subprocess.run([cls.ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=12",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "4",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
            "-movflags", "+faststart", str(path)], check=True, capture_output=True, timeout=20)
        cls.video = path.read_bytes()

    def setUp(self):
        self.fixture = fixtures.MediaEditTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.root = self.fixture.root
        self.fixture.originals[1].write_bytes(self.video)
        with closing(sqlite3.connect(self.root / "state/state.db")) as db:
            with db:
                db.execute("UPDATE jobs SET size=?,sha256=? WHERE media_id=?",
                    (len(self.video), hashlib.sha256(self.video).hexdigest(), self.fixture.ids[1]))
        self.before = self.fixture.preserved()

    def trim(self, source=None, start=0.5, end=3.5):
        result = fixtures.editor.execute({"root": str(self.root), "postKey": self.fixture.key,
            "mediaId": source or self.fixture.ids[1], "kind": "trim", "start": start, "end": end})
        self.assertTrue(result["ok"])
        return result["mediaId"]

    def capture(self, source):
        result = subprocess.run([self.ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error",
            "-ss", "0.25", "-i", str(self.path(source, "mp4")), "-frames:v", "1",
            "-f", "image2pipe", "-vcodec", "png", "pipe:1"], capture_output=True, check=True, timeout=20)
        return fixtures.editor.execute(self.fixture.capture_request(mediaId=source, time=0.25,
            pngBase64=base64.b64encode(result.stdout).decode("ascii")))["mediaId"]

    def crop(self, source=None):
        request = self.fixture.request if source is None else {**self.fixture.request,
            "mediaId": source, "crop": {"x": 4, "y": 6, "width": 80, "height": 60}}
        return fixtures.editor.execute(request)["mediaId"]

    def path(self, media_id, extension):
        return self.root / f"media/files/{self.fixture.library}/{media_id}.{extension}"

    def rows(self):
        with closing(sqlite3.connect(self.root / "state/state.db")) as db:
            return db.execute("SELECT * FROM media_edits ORDER BY sequence").fetchall()

    def delete(self, media_id=None):
        request = {"command": "prepare", "root": str(self.root), "postKey": self.fixture.key,
            "kind": "edit" if media_id else "post"}
        if media_id:
            request["mediaId"] = media_id
        prepared = deletion.execute(request)
        self.assertTrue(prepared["ok"])
        result = deletion.execute({**request, "command": "commit", "fingerprint": prepared["fingerprint"]})
        self.assertTrue(result["ok"])

    def test_migration_and_mixed_lineage_keep_creation_order_and_original_state(self):
        image = self.crop()
        old_rows = self.rows()
        self.assertEqual(len(old_rows[0]), len(edit_schema.BASE_COLUMNS))
        video = self.trim()
        capture = self.capture(video)
        retrim = self.trim(video, 0.25, 2.25)
        recrop = self.crop(capture)
        rows = self.rows()
        self.assertEqual(rows[0][:len(edit_schema.BASE_COLUMNS)], old_rows[0])
        self.assertEqual(rows[0][-2:], (None, None))
        self.assertEqual(rows[1][-4:], (None, None, 0.5, 3.5))
        snapshot = self.fixture.snapshot()
        post = snapshot["snapshot"]["posts"][0]
        self.assertEqual(len(post["attachments"]), 2)
        self.assertEqual([item["status"] for item in post["attachments"]], ["saved", "saved"])
        self.assertEqual([(item["mediaId"], item["kind"], item["editType"], item["ordinal"], item["status"])
            for item in post["edits"]], [(image, "image", "crop", 3, "saved"),
            (video, "video", "trim", 4, "saved"), (capture, "image", "capture", 5, "saved"),
            (retrim, "video", "trim", 6, "saved"), (recrop, "image", "crop", 7, "saved")])
        self.assertEqual([item["sourceMediaId"] for item in post["edits"]],
            [self.fixture.ids[0], self.fixture.ids[1], video, video, capture])
        registered = {item["id"]: item for item in snapshot["files"]}
        for media_id in (video, retrim):
            self.assertEqual(registered[media_id]["kind"], "video")
            self.assertTrue(registered[media_id]["relativePath"].endswith(f"/{media_id}.mp4"))
        probe = subprocess.run([self.ffprobe, "-v", "error", "-show_format", "-show_streams",
            "-of", "json", str(self.path(retrim, "mp4"))], capture_output=True, text=True,
            check=True, timeout=10)
        metadata = json.loads(probe.stdout)
        self.assertAlmostEqual(float(metadata["format"]["duration"]), 2, delta=0.2)
        self.assertEqual([stream["codec_name"] for stream in metadata["streams"]], ["h264", "aac"])
        self.assertEqual(self.before, self.fixture.preserved())
        self.assertFalse((self.root / "_work/collector.lock").exists())

    def test_zip_contains_mp4_and_png_edits_after_originals(self):
        image = self.crop()
        video = self.trim()
        capture = self.capture(video)
        destination = self.fixture.base / "AbC_01.zip"
        result = fixtures.export_post.export_post({"root": str(self.root), "postKey": self.fixture.key,
            "destination": str(destination)})
        self.assertTrue(result["ok"])
        with zipfile.ZipFile(destination) as archive:
            self.assertEqual(archive.namelist(), ["01.png", "02.mp4", "03.png", "04.mp4", "05.png", "게시글정보.txt"])
            self.assertEqual(archive.read("02.mp4"), self.video)
            for name, media_id, extension in (("03.png", image, "png"), ("04.mp4", video, "mp4"),
                    ("05.png", capture, "png")):
                self.assertEqual(archive.read(name), self.path(media_id, extension).read_bytes())
        self.assertEqual(self.before, self.fixture.preserved())

    def test_deleted_trim_preserves_video_and_image_descendants_and_history(self):
        parent = self.trim()
        child = self.trim(parent, 0.25, 2.25)
        capture = self.capture(parent)
        cropped = self.crop(capture)
        before_rows = self.rows()
        self.delete(parent)
        self.assertFalse(self.path(parent, "mp4").exists())
        self.assertEqual(self.rows(), before_rows)
        snapshot = self.fixture.snapshot()
        edits = snapshot["snapshot"]["posts"][0]["edits"]
        self.assertEqual([item["mediaId"] for item in edits], [child, capture, cropped])
        self.assertEqual([item["status"] for item in edits], ["saved"]*3)
        self.assertNotIn(parent, {item["id"] for item in snapshot["files"]})
        self.assertEqual(self.before, self.fixture.preserved())
        self.capture(child)
        self.trim(child, 0.25, 1.25)
        self.assertEqual([item["status"] for item in self.fixture.snapshot()["snapshot"]["posts"][0]["edits"]], ["saved"]*5)
        destination = self.fixture.base / "descendants.zip"
        self.assertTrue(fixtures.export_post.export_post({"root": str(self.root), "postKey": self.fixture.key,
            "destination": str(destination)})["ok"])
        with zipfile.ZipFile(destination) as archive:
            self.assertEqual(archive.namelist(), ["01.png", "02.mp4", "03.mp4", "04.png", "05.png", "06.png", "07.mp4", "게시글정보.txt"])
        self.assertEqual(self.before, self.fixture.preserved())

    def test_post_deletion_removes_all_edit_formats_but_preserves_records(self):
        image = self.crop()
        video = self.trim()
        capture = self.capture(video)
        paths = [*self.fixture.originals, self.path(image, "png"), self.path(video, "mp4"), self.path(capture, "png")]
        before_rows = self.rows()
        self.delete()
        self.assertTrue(all(not path.exists() for path in paths))
        self.assertEqual(self.rows(), before_rows)
        snapshot = self.fixture.snapshot()
        self.assertEqual(snapshot["snapshot"]["posts"], [])
        self.assertEqual(snapshot["files"], [])
        with closing(sqlite3.connect(self.root / "state/state.db")) as db:
            self.assertEqual({name: db.execute(f"SELECT * FROM {name}").fetchall()
                for name in self.before["tables"]}, self.before["tables"])
            self.assertEqual(db.execute("SELECT account,post_id FROM post_deletions").fetchall(), [("Example", "AbC_01")])
        self.assertNotEqual(self.fixture.source.read_bytes(), self.before["source"])

    def test_tampered_trim_never_enters_registry_or_zip_and_download_state_is_unchanged(self):
        before_download = inspection.read_status(self.root)
        video = self.trim()
        self.path(video, "mp4").write_bytes(b"tampered-mp4")
        snapshot = self.fixture.snapshot()
        post = snapshot["snapshot"]["posts"][0]
        self.assertEqual(post["edits"][0]["status"], "review")
        self.assertEqual([item["status"] for item in post["attachments"]], ["saved", "saved"])
        self.assertNotIn(video, {item["id"] for item in snapshot["files"]})
        with self.assertRaises(fixtures.export_post.ExportError):
            fixtures.export_post.export_post({"root": str(self.root), "postKey": self.fixture.key,
                "destination": str(self.fixture.base / "bad.zip")})
        after_download = inspection.read_status(self.root)
        for key in ("problem", "nextAllowedAt", "jobs", "links"):
            self.assertEqual(before_download[key], after_download[key])
        self.assertEqual(self.before, self.fixture.preserved())


if __name__ == "__main__":
    unittest.main()
