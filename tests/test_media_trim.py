"""Real local ffmpeg trim, audio preservation, schema migration, and cleanup."""
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import test_media_edit as fixtures
import edit_schema
import video_trim


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "Local ffmpeg/ffprobe are required")
class MediaTrimTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.generated = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.generated.cleanup)
        cls.video = Path(cls.generated.name) / "source.mp4"
        cls.silent = Path(cls.generated.name) / "silent.mp4"
        subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "5", "-c:v", "libx264",
            "-c:a", "aac", "-pix_fmt", "yuv420p", str(cls.video)], check=True, capture_output=True, timeout=20)
        subprocess.run(["ffmpeg", "-v", "error", "-i", str(cls.video), "-an", "-c:v", "copy", str(cls.silent)],
            check=True, capture_output=True, timeout=20)

    def setUp(self):
        self.fixture = fixtures.MediaEditTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.root = self.fixture.root
        self.editor = fixtures.editor
        self.replace_video(self.video.read_bytes())
        self.request = {"root": str(self.root), "postKey": self.fixture.key, "mediaId": self.fixture.ids[1],
            "kind": "trim", "start": 2, "end": 4}
        self.before = self.fixture.preserved()

    def replace_video(self, raw):
        self.fixture.originals[1].write_bytes(raw)
        with closing(sqlite3.connect(self.root / "state/state.db")) as db, db:
            db.execute("UPDATE jobs SET size=?,sha256=? WHERE media_id=?",
                (len(raw), hashlib.sha256(raw).hexdigest(), self.fixture.ids[1]))

    def output(self, media_id): return self.root / f"media/files/{self.fixture.library}/{media_id}.mp4"

    def clean(self):
        self.assertFalse((self.root / "_work/collector.lock").exists())
        self.assertEqual(list((self.root / "media/.partial").glob("*.edit.*")), [])
        self.assertEqual(self.fixture.preserved(), self.before)

    def edit_rows(self):
        with closing(sqlite3.connect(self.root / "state/state.db")) as db:
            exists = db.execute("SELECT 1 FROM sqlite_master WHERE name='media_edits'").fetchone()
            return db.execute("SELECT * FROM media_edits").fetchall() if exists else []

    def test_real_two_to_four_seconds_has_correct_content_duration_h264_and_audio(self):
        result = self.editor.execute(self.request)
        path = self.output(result["mediaId"])
        metadata = video_trim.probe(path, video_trim.dependencies(), lambda: False)
        self.assertAlmostEqual(metadata["duration"], 2, delta=0.001)
        self.assertEqual((metadata["width"], metadata["height"], metadata["videoCodec"], metadata["audioCodecs"]), (160, 90, "h264", ["aac"]))
        def frame(path, at):
            return subprocess.run(["ffmpeg", "-v", "error", "-ss", str(at), "-i", str(path), "-frames:v", "1",
                "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], capture_output=True, check=True, timeout=10).stdout
        original, edited = frame(self.fixture.originals[1], 2), frame(path, 0)
        self.assertEqual(len(original), len(edited))
        self.assertLess(sum(abs(a-b) for a, b in zip(original, edited))/len(original), 5)
        samples = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-map", "0:a:0", "-f", "s16le", "pipe:1"],
            capture_output=True, check=True, timeout=10).stdout
        self.assertGreater(len(samples), 48000*2)
        self.assertGreater(len(set(samples)), 100)
        post = self.fixture.snapshot()["snapshot"]["posts"][0]
        self.assertEqual([(item["kind"], item["editType"], item["ordinal"]) for item in post["edits"]], [("video", "trim", 3)])
        self.clean()

    def test_legacy_table_migrates_without_changing_any_original_edit_values(self):
        cropped = self.editor.execute(self.fixture.request)["mediaId"]
        rows = self.edit_rows()
        before_png = self.fixture.edit_path(cropped).read_bytes()
        with closing(sqlite3.connect(self.root / "state/state.db")) as db:
            before_schema = db.execute("SELECT sql FROM sqlite_master WHERE name='media_edits'").fetchone()[0]
        self.assertNotIn("'trim'", before_schema)
        trimmed = self.editor.execute(self.request)["mediaId"]
        with closing(sqlite3.connect(self.root / "state/state.db")) as db:
            old_rows = db.execute(f"SELECT {','.join(edit_schema.BASE_COLUMNS)} FROM media_edits WHERE edit_type!='trim'").fetchall()
            self.assertEqual(old_rows, rows)
            self.assertEqual(db.execute("SELECT trim_start,trim_end,crop_json,capture_time FROM media_edits WHERE edit_id=?", (trimmed,)).fetchone(), (2, 4, None, None))
        self.assertEqual(self.fixture.edit_path(cropped).read_bytes(), before_png)
        captured = self.editor.execute({**self.fixture.capture_request(), "mediaId": trimmed})["mediaId"]
        again = self.editor.execute({**self.request, "mediaId": trimmed, "start": 0.5, "end": 1.5})["mediaId"]
        self.assertTrue(self.fixture.edit_path(captured).exists())
        self.assertTrue(self.output(again).exists())
        self.assertEqual([item["ordinal"] for item in self.fixture.snapshot()["snapshot"]["posts"][0]["edits"]], [3, 4, 5, 6])
        self.clean()

    def test_whole_silent_source_keeps_silence_and_zero_to_end_boundaries(self):
        self.replace_video(self.silent.read_bytes())
        self.before = self.fixture.preserved()
        result = self.editor.execute({**self.request, "start": 0, "end": 5})
        metadata = video_trim.probe(self.output(result["mediaId"]), video_trim.dependencies(), lambda: False)
        self.assertEqual(metadata["audioCodecs"], [])
        self.assertAlmostEqual(metadata["duration"], 5, delta=0.04)
        self.clean()

    def test_full_native_container_duration_retrim_clamps_only_aac_padding(self):
        first = self.editor.execute(self.request)["mediaId"]
        metadata = video_trim.probe(self.output(first), video_trim.dependencies(), lambda: False)
        self.assertAlmostEqual(metadata["duration"], 2, delta=0.001)
        self.assertGreater(metadata["containerDuration"], metadata["duration"])
        self.assertEqual(metadata["selectionEnd"], metadata["containerDuration"])
        full = self.editor.execute({**self.request, "mediaId": first, "start": 0, "end": metadata["containerDuration"]})["mediaId"]
        second = video_trim.probe(self.output(full), video_trim.dependencies(), lambda: False)
        self.assertAlmostEqual(second["duration"], 2, delta=0.001)
        self.assertEqual(second["audioCodecs"], ["aac"])
        for start, end in ((0, metadata["containerDuration"]+0.001),
                           (metadata["duration"], metadata["containerDuration"])):
            with self.subTest(start=start, end=end), self.assertRaises(video_trim.TrimError) as caught:
                self.editor.execute({**self.request, "mediaId": first, "start": start, "end": end})
            self.assertEqual(caught.exception.code, "invalid_trim")
        self.clean()

    def test_longer_audio_tail_never_extends_video_selection(self):
        path = self.fixture.base / "longer-audio.mp4"
        subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30:duration=2",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=3", "-c:v", "libx264", "-c:a", "aac", str(path)],
            check=True, capture_output=True, timeout=20)
        self.replace_video(path.read_bytes())
        self.before = self.fixture.preserved()
        metadata = video_trim.probe(path, video_trim.dependencies(), lambda: False)
        self.assertAlmostEqual(metadata["duration"], 2, delta=0.001)
        self.assertGreater(metadata["containerDuration"], 2.9)
        self.assertEqual(metadata["selectionEnd"], 2)
        with self.assertRaises(video_trim.TrimError) as caught:
            self.editor.execute({**self.request, "start": 0, "end": metadata["containerDuration"]})
        self.assertEqual(caught.exception.code, "invalid_trim")
        self.clean()

    def test_windows_process_environment_contains_only_systemroot(self):
        with patch.dict(os.environ, {"SystemRoot": r"C:\Windows", "UNRELATED_TOKEN": "do-not-pass"}, clear=True):
            with patch.object(video_trim.os, "name", "nt"):
                self.assertEqual(video_trim.process_environment(), {"SystemRoot": r"C:\Windows"})
            with patch.object(video_trim.os, "name", "posix"):
                self.assertEqual(video_trim.process_environment(), {})

    def test_invalid_numbers_fail_before_starting_subprocess(self):
        cases = [(-1, 1), (2, 2), (3, 2), (True, 4), (2, False), ("2", 4), (float("nan"), 4), (2, float("inf"))]
        with patch.object(video_trim.subprocess, "Popen", side_effect=AssertionError("invalid input must not spawn")):
            for start, end in cases:
                with self.subTest(start=start, end=end), self.assertRaises(self.editor.EditError) as caught:
                    self.editor.execute({**self.request, "start": start, "end": end})
                self.assertEqual(caught.exception.code, "invalid_trim")
        self.assertEqual(self.edit_rows(), [])
        self.clean()

    def test_range_outside_actual_duration_and_image_source_are_rejected(self):
        for start, end in ((0, 6), (5, 5.1)):
            with self.assertRaises(video_trim.TrimError) as caught:
                self.editor.execute({**self.request, "start": start, "end": end})
            self.assertEqual(caught.exception.code, "invalid_trim")
        with self.assertRaises(self.editor.EditError) as caught:
            self.editor.execute({**self.request, "mediaId": self.fixture.ids[0]})
        self.assertEqual(caught.exception.code, "edit_source_unavailable")
        self.clean()

    def test_missing_ffmpeg_or_ffprobe_creates_no_result(self):
        actual = shutil.which
        for missing in ("ffmpeg", "ffprobe"):
            with patch.object(video_trim.shutil, "which", side_effect=lambda name: None if name == missing else actual(name)):
                with self.assertRaises(video_trim.TrimError) as caught: self.editor.execute(self.request)
                self.assertEqual(caught.exception.code, "video_dependency")
        self.assertEqual(self.edit_rows(), [])
        self.clean()

    def test_cancellation_reaps_real_encoder_and_removes_partial_file(self):
        actual = subprocess.Popen
        children = []
        def spawning(command, **kwargs):
            child = actual(command, **kwargs)
            if Path(command[0]).name == "ffmpeg": children.append(child)
            return child
        with patch.object(video_trim.subprocess, "Popen", side_effect=spawning):
            with self.assertRaises(video_trim.TrimError) as caught:
                self.editor.execute(self.request, check=lambda: bool(children))
        self.assertEqual(caught.exception.code, "cancelled")
        self.assertTrue(children)
        self.assertTrue(all(child.poll() is not None for child in children))
        self.assertEqual(self.edit_rows(), [])
        self.clean()

    def test_encode_timeout_reaps_child_and_preserves_originals(self):
        actual = subprocess.Popen
        children = []
        def spawning(command, **kwargs):
            child = actual(command, **kwargs)
            children.append(child)
            return child
        with patch.object(video_trim, "ENCODE_TIMEOUT", 0), patch.object(video_trim.subprocess, "Popen", side_effect=spawning):
            with self.assertRaises(video_trim.TrimError) as caught: self.editor.execute(self.request)
        self.assertEqual(caught.exception.code, "video_timeout")
        self.assertTrue(all(child.poll() is not None for child in children))
        self.assertEqual(self.edit_rows(), [])
        self.clean()

    def test_sigterm_worker_cleans_encoder_before_returning_cancelled(self):
        marker = self.fixture.base / "encoder-pid"
        code = """
import sys
from pathlib import Path
sys.path.insert(0,sys.argv[1])
import edit_media,video_trim
real=video_trim.subprocess.Popen
def spawn(command,**kwargs):
    if Path(command[0]).name=='ffmpeg': command=command[:1]+['-re']+command[1:]
    child=real(command,**kwargs)
    if Path(command[0]).name=='ffmpeg': Path(sys.argv[2]).write_text(str(child.pid))
    return child
video_trim.subprocess.Popen=spawn
sys.exit(edit_media.main())
"""
        process = subprocess.Popen([sys.executable, "-I", "-B", "-c", code, str(Path(self.editor.__file__).parent), str(marker)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.addCleanup(lambda: process.kill() if process.poll() is None else None)
        process.stdin.write(json.dumps(self.request).encode())
        process.stdin.close()
        process.stdin = None
        deadline = time.monotonic()+10
        while not marker.exists() and time.monotonic() < deadline and process.poll() is None: time.sleep(0.02)
        self.assertTrue(marker.exists())
        child_pid = int(marker.read_text())
        process.send_signal(signal.SIGTERM)
        stdout, stderr = process.communicate(timeout=10)
        self.assertEqual(stderr, b"")
        self.assertEqual(json.loads(stdout)["error"]["code"], "cancelled")
        self.assertEqual(process.returncode, 1)
        with self.assertRaises(ProcessLookupError): os.kill(child_pid, 0)
        self.assertEqual(self.edit_rows(), [])
        self.clean()

    def test_publication_failure_rolls_back_schema_upgrade_and_keeps_earlier_edits(self):
        self.editor.execute(self.fixture.request)
        before_rows = self.edit_rows()
        with closing(sqlite3.connect(self.root / "state/state.db")) as db:
            before_schema = db.execute("SELECT sql FROM sqlite_master WHERE name='media_edits'").fetchone()[0]
        with patch.object(self.editor.os, "link", side_effect=OSError("publication failed")):
            with self.assertRaises(OSError): self.editor.execute(self.request)
        self.assertEqual(self.edit_rows(), before_rows)
        with closing(sqlite3.connect(self.root / "state/state.db")) as db:
            self.assertEqual(db.execute("SELECT sql FROM sqlite_master WHERE name='media_edits'").fetchone()[0], before_schema)
        self.assertEqual(list((self.root / f"media/files/{self.fixture.library}").glob("*.mp4")), [])
        self.clean()

    def test_cancel_after_publication_rolls_back_new_video_and_optional_schema(self):
        stop = False
        actual = self.editor.sync_directory
        def syncing(path):
            nonlocal stop
            actual(path)
            stop = True
        with patch.object(self.editor, "sync_directory", side_effect=syncing):
            with self.assertRaises(self.editor.EditError) as caught: self.editor.execute(self.request, check=lambda: stop)
        self.assertEqual(caught.exception.code, "cancelled")
        self.assertEqual(self.edit_rows(), [])
        self.assertEqual(list((self.root / f"media/files/{self.fixture.library}").glob("*.mp4")), [])
        self.clean()

    def test_changed_source_during_encoding_never_publishes_trim(self):
        actual = video_trim.encode
        def changed(*args):
            actual(*args)
            self.fixture.originals[1].write_bytes(b"external modification")
        with patch.object(video_trim, "encode", side_effect=changed):
            with self.assertRaises(self.editor.EditError) as caught: self.editor.execute(self.request)
        self.assertEqual(caught.exception.code, "source_changed")
        self.assertEqual(self.edit_rows(), [])
        self.assertEqual(list((self.root / "media/.partial").glob("*.edit.*")), [])
        self.assertEqual(self.fixture.preserved()["tables"], self.before["tables"])

    def test_staged_video_tampering_is_rejected_before_publication(self):
        actual = fixtures.view.read_snapshot
        calls = 0
        def snapshot(*args, **kwargs):
            nonlocal calls
            calls += 1
            result = actual(*args, **kwargs)
            if calls == 3: next((self.root / "media/.partial").glob("*.edit.mp4")).write_bytes(b"tampered")
            return result
        with patch.object(fixtures.view, "read_snapshot", side_effect=snapshot):
            with self.assertRaises(self.editor.EditError) as caught: self.editor.execute(self.request)
        self.assertEqual(caught.exception.code, "edit_file_changed")
        self.assertEqual(self.edit_rows(), [])
        self.clean()

    def test_unknown_schema_extensions_are_preserved_and_block_upgrade(self):
        self.editor.execute(self.fixture.request)
        before = self.edit_rows()
        with closing(sqlite3.connect(self.root / "state/state.db")) as db, db:
            db.execute("CREATE INDEX user_edit_index ON media_edits(created_at)")
        with self.assertRaises(edit_schema.EditSchemaError): self.editor.execute(self.request)
        self.assertEqual(self.edit_rows(), before)
        with closing(sqlite3.connect(self.root / "state/state.db")) as db:
            self.assertIsNotNone(db.execute("SELECT sql FROM sqlite_master WHERE name='user_edit_index'").fetchone())
        self.clean()

    def test_cli_isolated_worker_uses_same_trim_contract(self):
        process = subprocess.run([sys.executable, "-I", "-B", self.editor.__file__],
            input=json.dumps(self.request), text=True, capture_output=True, timeout=20)
        self.assertEqual(process.returncode, 0, process.stderr+process.stdout)
        self.assertEqual(process.stderr, "")
        result = json.loads(process.stdout)
        self.assertTrue(result["ok"])
        self.assertTrue(self.output(result["mediaId"]).exists())
        self.clean()


if __name__ == "__main__": unittest.main()
