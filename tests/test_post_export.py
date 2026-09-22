"""ZIP exports are all-or-nothing copies of current, verified local attachments."""
from contextlib import ExitStack
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "local-runtime"))
import export_post as exporter
from test_collection_source import payload, workbook
from threads_runner.state import State


class PostExportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name).resolve()
        self.root = self.base / "자료"
        self.root.mkdir()
        self.output = self.base / "내보내기"
        self.output.mkdir()
        self.destination = self.output / "AbC_01.zip"
        self.key = json.dumps(["Example", "AbC_01"], separators=(",", ":"))
        self.source = self.root / "results/2026/09/threads-2026-09-21.xlsx"
        self.data = payload()
        self.data["posts"][0].update({"이미지 수": 2, "영상 수": 1, "캡션": "한국어 🍀\n\nsecond line\n"})
        first = self.data["media"][0]
        self.data["media"] = [
            {**first, "순서": ordinal, "종류": kind, "다운로드URL": f"https://cdn.example.test/{ordinal}.{extension}"}
            for ordinal, (kind, extension) in enumerate((("image", "jpg"), ("video", "mp4"), ("image", "png")), 1)
        ]
        self.write_source()
        self.bytes = [b"synthetic-first-image", b"synthetic-video\0\xff", b"synthetic-last-image"]
        self.paths = []
        with State(self.root) as state:
            for ordinal, item in enumerate(self.data["media"], 1):
                media_id, job_id = f"{ordinal:032x}", f"{ordinal + 10:032x}"
                extension = ("jpg", "mp4", "png")[ordinal - 1]
                relative = f"media/files/{'b' * 32}/{media_id}.{extension}"
                path = self.root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                raw = self.bytes[ordinal - 1]
                path.write_bytes(raw)
                self.paths.append(path)
                with state.db:
                    state.db.execute("INSERT INTO media VALUES (?,?,?,?,?)", (media_id, "Example", "AbC_01", ordinal, item["종류"]))
                    state.db.execute("""INSERT INTO jobs(job_id,media_id,source_rel,source_sha256,source_type,run_id,url_hash,status,final_rel,size,sha256,updated_at)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""", (job_id, media_id, "source", "d" * 64, "jsonl", "RunA", "e" * 64,
                            "complete", relative, len(raw), hashlib.sha256(raw).hexdigest(), 1))
        self.request = {"root": str(self.root), "postKey": self.key, "destination": str(self.destination)}

    def tearDown(self):
        self.temp.cleanup()

    def write_source(self):
        workbook(self.source, {"게시글": self.data["posts"], "미디어": self.data["media"], "실행기록": [self.data["run"]]})

    def hashes(self):
        return {str(path.relative_to(self.root)): hashlib.sha256(path.read_bytes()).hexdigest()
                for path in self.root.rglob("*") if path.is_file()}

    def assert_preserved_failure(self, code=None):
        self.destination.write_bytes(b"existing ZIP must survive")
        with self.assertRaises((exporter.ExportError, exporter.SourceError)) as caught:
            exporter.export_post(self.request)
        if code:
            self.assertEqual(caught.exception.code, code)
        self.assertEqual(self.destination.read_bytes(), b"existing ZIP must survive")
        self.assertEqual(list(self.output.iterdir()), [self.destination])

    def test_mixed_media_order_exact_text_and_read_only_source(self):
        before = self.hashes()
        with ExitStack() as stack:
            for name in ("socket.create_connection", "urllib.request.urlopen", "threads_runner.state.State.__enter__"):
                stack.enter_context(patch(name, side_effect=AssertionError("No network or DB mutation")))
            result = exporter.export_post(self.request)
        self.assertEqual(result, {"ok": True, "fileName": "AbC_01.zip"})
        self.assertEqual(before, self.hashes())
        with zipfile.ZipFile(self.destination) as archive:
            self.assertIsNone(archive.testzip())
            self.assertEqual(archive.namelist(), ["01.jpg", "02.mp4", "03.png", "게시글정보.txt"])
            for name, raw in zip(archive.namelist(), self.bytes):
                self.assertEqual(archive.read(name), raw)
            self.assertEqual(archive.read("게시글정보.txt").decode("utf-8"),
                "계정명: @Example\n수집일: 2026-09-21 12:00:00 KST\n"
                "원문 주소: https://www.threads.com/@example/post/AbC_01\n\n캡션\n한국어 🍀\n\nsecond line\n")

    def test_partial_observed_attachment_count_can_export_all_saved_files(self):
        self.data["posts"][0]["첨부 상태"] = "partial"
        self.write_source()
        self.assertTrue(exporter.export_post(self.request)["ok"])
        with zipfile.ZipFile(self.destination) as archive:
            self.assertEqual(len(archive.namelist()), 4)

    def test_empty_caption_is_not_replaced(self):
        self.data["posts"][0]["캡션"] = ""
        self.write_source()
        exporter.export_post(self.request)
        with zipfile.ZipFile(self.destination) as archive:
            self.assertTrue(archive.read("게시글정보.txt").decode("utf-8").endswith("\n캡션\n"))

    def test_metadata_converts_date_to_kst_and_preserves_caption_linebreaks(self):
        self.assertEqual(exporter.post_text({"account": "한글", "collectedAt": "2026-09-21T23:30:00+00:00",
            "originalUrl": "https://example.test/원문", "caption": "one\r\ntwo\n"}).decode("utf-8"),
            "계정명: @한글\n수집일: 2026-09-22 08:30:00 KST\n원문 주소: https://example.test/원문\n\n캡션\none\r\ntwo\n")

    def test_missing_file_never_creates_partial_archive(self):
        self.paths[1].unlink()
        self.assert_preserved_failure("attachments_incomplete")

    def test_tampered_same_size_file_never_creates_partial_archive(self):
        self.paths[2].write_bytes(b"x" * len(self.bytes[2]))
        self.assert_preserved_failure("attachments_incomplete")

    def test_missing_post_and_no_attachments_are_rejected(self):
        self.request["postKey"] = '["Example","missing"]'
        self.assert_preserved_failure("post_missing")
        self.request["postKey"] = self.key
        snapshot = exporter.read_snapshot(self.root)
        snapshot["snapshot"]["posts"][0]["attachments"] = []
        with patch.object(exporter, "read_snapshot", return_value=snapshot):
            self.assert_preserved_failure("attachments_missing")

    def test_registered_media_identity_kind_and_path_must_match(self):
        original = exporter.read_snapshot(self.root)
        for change, code in (("id", "attachments_incomplete"), ("kind", "attachments_incomplete"),
                             ("path", "invalid_local_path"), ("duplicate", "attachments_incomplete")):
            with self.subTest(change=change):
                snapshot = copy.deepcopy(original)
                if change == "id": snapshot["files"][0]["id"] = "f" * 32
                if change == "kind": snapshot["files"][0]["kind"] = "video"
                if change == "path": snapshot["files"][0]["relativePath"] = "media/files/../../outside.jpg"
                if change == "duplicate": snapshot["snapshot"]["posts"][0]["attachments"][1]["ordinal"] = 1
                with patch.object(exporter, "read_snapshot", return_value=snapshot):
                    self.assert_preserved_failure(code)

    def test_source_symlink_and_hardlink_are_rejected(self):
        path = self.paths[0]
        moved = self.base / "outside.jpg"
        path.rename(moved)
        path.symlink_to(moved)
        self.assert_preserved_failure("attachments_incomplete")
        path.unlink()
        os.link(moved, path)
        self.assert_preserved_failure("attachments_incomplete")

    def test_destination_must_be_outside_library_and_a_zip(self):
        for destination in (self.root / "post.zip", self.root / "media/post.zip", self.output / "post.txt", Path("relative.zip")):
            with self.subTest(destination=destination), self.assertRaises(exporter.ExportError):
                exporter.export_post({**self.request, "destination": str(destination)})
        self.assertEqual(list(self.output.iterdir()), [])

    def test_destination_symlink_hardlink_and_symlink_parent_are_rejected(self):
        outside = self.base / "keep.zip"
        outside.write_bytes(b"keep")
        self.destination.symlink_to(outside)
        with self.assertRaises(exporter.SourceError): exporter.export_post(self.request)
        self.destination.unlink()
        os.link(outside, self.destination)
        with self.assertRaises(exporter.ExportError): exporter.export_post(self.request)
        self.destination.unlink()
        link = self.base / "linked-folder"
        link.symlink_to(self.output, target_is_directory=True)
        with self.assertRaises(exporter.SourceError):
            exporter.export_post({**self.request, "destination": str(link / "post.zip")})
        self.assertEqual(outside.read_bytes(), b"keep")
        self.assertEqual(list(self.output.iterdir()), [])

    def test_valid_existing_zip_is_replaced_atomically(self):
        self.destination.write_bytes(b"selected old ZIP")
        self.assertTrue(exporter.export_post(self.request)["ok"])
        with zipfile.ZipFile(self.destination) as archive:
            self.assertEqual(archive.read("02.mp4"), self.bytes[1])
        self.assertEqual(list(self.output.iterdir()), [self.destination])

    def test_destination_changed_during_export_is_preserved(self):
        actual = exporter.copy_media
        def change_destination(*args):
            result = actual(*args)
            self.destination.write_bytes(b"external change")
            return result
        with patch.object(exporter, "copy_media", side_effect=change_destination), self.assertRaises(exporter.ExportError) as caught:
            exporter.export_post(self.request)
        self.assertEqual(caught.exception.code, "destination_changed")
        self.assertEqual(self.destination.read_bytes(), b"external change")
        self.assertEqual(list(self.output.iterdir()), [self.destination])

    def test_metadata_changed_during_export_preserves_existing_destination(self):
        actual = exporter.copy_media
        def change_source(*args):
            result = actual(*args)
            self.data["posts"][0]["캡션"] = "changed metadata"
            self.write_source()
            return result
        with patch.object(exporter, "copy_media", side_effect=change_source):
            self.assert_preserved_failure("source_changed")

    def test_file_changed_after_initial_snapshot_is_detected(self):
        actual = exporter.copy_media
        def change_before_copy(archive, root, item, check):
            path = root / item["relativePath"]
            path.write_bytes(b"z" * item["size"])
            return actual(archive, root, item, check)
        with patch.object(exporter, "copy_media", side_effect=change_before_copy):
            self.assert_preserved_failure("local_file_changed")

    def test_cancel_after_copy_cleans_temporary_and_preserves_destination(self):
        self.destination.write_bytes(b"keep")
        actual = exporter.copy_media
        stopped = False
        def cancel_after_copy(*args):
            nonlocal stopped
            result = actual(*args)
            stopped = True
            return result
        with patch.object(exporter, "copy_media", side_effect=cancel_after_copy), self.assertRaises(exporter.ExportError) as caught:
            exporter.export_post(self.request, check=lambda: stopped)
        self.assertEqual(caught.exception.code, "cancelled")
        self.assertEqual(self.destination.read_bytes(), b"keep")
        self.assertEqual(list(self.output.iterdir()), [self.destination])

    def test_write_failure_cleans_temporary_and_preserves_destination(self):
        with patch.object(zipfile.ZipFile, "writestr", side_effect=OSError("disk full")):
            self.destination.write_bytes(b"keep")
            with self.assertRaises(OSError): exporter.export_post(self.request)
        self.assertEqual(self.destination.read_bytes(), b"keep")
        self.assertEqual(list(self.output.iterdir()), [self.destination])

    def test_cli_isolated_mode_and_bounded_invalid_input(self):
        script = str(Path(exporter.__file__))
        result = subprocess.run([sys.executable, "-I", "-B", script], input=json.dumps(self.request),
            text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {"ok": True, "fileName": "AbC_01.zip"})
        for raw in ("", "{", "[]", "x" * (exporter.INPUT_LIMIT + 1)):
            with self.subTest(size=len(raw)):
                result = subprocess.run([sys.executable, "-I", "-B", script], input=raw,
                    text=True, capture_output=True, timeout=10)
                self.assertEqual(result.returncode, 1)
                self.assertFalse(json.loads(result.stdout)["ok"])
                self.assertEqual(result.stderr, "")

    @unittest.skipIf(os.name == "nt", "Windows terminate forcibly exits; graceful signals are POSIX-only")
    def test_sigterm_cleans_temporary_and_keeps_existing_zip(self):
        self.destination.write_bytes(b"existing selected archive")
        ready = self.base / "worker-ready"
        code = "\n".join([
            "import sys, time", f"sys.path.insert(0, {str(Path(exporter.__file__).parent)!r})",
            "import export_post", f"ready = export_post.Path({str(ready)!r})",
            "actual = export_post.copy_media", "def wait_for_signal(archive, root, item, check):",
            "    ready.write_text('ready')", "    while not check(): time.sleep(.01)",
            "    return actual(archive, root, item, check)",
            "export_post.copy_media = wait_for_signal", "sys.exit(export_post.main())",
        ])
        worker = subprocess.Popen([sys.executable, "-I", "-B", "-c", code], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            worker.stdin.write(json.dumps(self.request))
            worker.stdin.close()
            worker.stdin = None
            deadline = time.monotonic() + 5
            while not ready.exists() and worker.poll() is None and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertTrue(ready.exists(), "Worker did not enter ZIP streaming")
            worker.terminate()
            stdout, stderr = worker.communicate(timeout=5)
            self.assertEqual(worker.returncode, 1)
            self.assertEqual(json.loads(stdout)["error"]["code"], "cancelled")
            self.assertEqual(stderr, "")
        finally:
            if worker.poll() is None:
                worker.kill()
                worker.communicate(timeout=5)
        self.assertEqual(self.destination.read_bytes(), b"existing selected archive")
        self.assertEqual(list(self.output.iterdir()), [self.destination])


if __name__ == "__main__":
    unittest.main()
