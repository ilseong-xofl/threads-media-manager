"""Synthetic read-only caption image preparation; no model or network calls."""
import hashlib
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "local-runtime"))
import caption_images as prepare
import test_media_edit as fixtures
from threads_source.workbook_write import patch_workbook


class CaptionImagesTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.MediaEditTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.temp = tempfile.TemporaryDirectory(prefix="tmm-caption-")
        self.addCleanup(self.temp.cleanup)
        self.output = Path(self.temp.name).resolve()
        self.token = "a" * 32
        (self.output / ".owner").write_text(self.token)
        self.data = {"root": str(self.fixture.root), "postKey": self.fixture.key,
                     "mediaIds": [self.fixture.ids[0]], "output": str(self.output), "token": self.token}
        prepare._cancelled = False

    def register_media(self, count, kind="video", account="Example"):
        """Additional completed local registrations; no transfer or video decode."""
        ids, paths = [], []
        raw = self.fixture.raw_image if kind == "image" else b"synthetic-video-not-decodable"
        extension = "png" if kind == "image" else "mp4"
        with closing(sqlite3.connect(self.fixture.root / "state/state.db")) as db, db:
            for ordinal in range(3, 3 + count):
                media_id = f"{100 + ordinal:032x}"
                relative = f"media/files/{self.fixture.library}/{media_id}.{extension}"
                path = self.fixture.root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(raw)
                db.execute("INSERT INTO media VALUES(?,?,?,?,?)", (media_id, account, "AbC_01", ordinal, kind))
                db.execute("""INSERT INTO jobs(job_id,media_id,source_rel,source_sha256,source_type,
                    run_id,url_hash,status,final_rel,size,sha256,updated_at)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""", (f"{1000 + ordinal:032x}", media_id,
                    "source", "d" * 64, "xlsx", "RunA", "e" * 64, "complete", relative,
                    len(raw), hashlib.sha256(raw).hexdigest(), 1))
                ids.append(media_id)
                paths.append(path)
        return ids, paths

    def test_selected_image_normalizes_exif_and_preserves_all_source_bytes(self):
        before = self.fixture.preserved()
        result = prepare.prepare(self.data)
        self.assertEqual(result["images"], ["image-01.jpg"])
        self.assertEqual(set(result), {"ok", "caption", "images"})
        self.assertEqual(result["caption"], self.fixture.snapshot()["snapshot"]["posts"][0]["caption"])
        with Image.open(self.output / "image-01.jpg") as image:
            self.assertEqual(image.size, (8, 12))
            self.assertEqual(image.format, "JPEG")
            self.assertEqual(dict(image.getexif()), {})
            self.assertNotIn("comment", image.info)
        self.assertEqual(before, self.fixture.preserved())
        self.assertFalse((self.fixture.root / "_work/collector.lock").exists())

    def test_saved_edit_is_supported(self):
        import edit_media
        edit_id = edit_media.execute(self.fixture.request)["mediaId"]
        result = prepare.prepare({**self.data, "mediaIds": [edit_id]})
        with Image.open(self.output / result["images"][0]) as image:
            self.assertEqual(image.size, (4, 5))

    def test_rejects_unknown_cross_post_duplicate_and_excess_ids_without_output(self):
        for ids in [["f" * 32], [self.fixture.ids[0]] * 2, [f"{i:032x}" for i in range(101)], ["../../file"]]:
            with self.subTest(ids=ids), self.assertRaises((prepare.PrepareError, prepare.view.SourceError)):
                prepare.prepare({**self.data, "mediaIds": ids})
        with self.assertRaises(prepare.PrepareError):
            prepare.prepare({**self.data, "postKey": '["Other","Post"]'})
        self.assertEqual([p.name for p in self.output.iterdir()], [".owner"])

    def test_mixed_selection_rejects_foreign_video_before_filtering(self):
        ids, _ = self.register_media(1, account="Other")
        with self.assertRaises(prepare.PrepareError) as error:
            prepare.prepare({**self.data, "mediaIds": [self.fixture.ids[0], ids[0]]})
        self.assertEqual(error.exception.code, "caption_source")
        self.assertEqual([p.name for p in self.output.iterdir()], [".owner"])

    def test_blank_original_caption_is_preserved(self):
        source = self.fixture.source
        source.write_bytes(patch_workbook(source.read_bytes(), {"게시글": [(7, {"캡션": ""})]}))
        before = self.fixture.preserved()
        result = prepare.prepare(self.data)
        self.assertEqual(result["caption"], "")
        self.assertEqual(before, self.fixture.preserved())

    def test_rejects_tampered_file(self):
        self.fixture.originals[0].write_bytes(b"changed")
        with self.assertRaises(prepare.PrepareError):
            prepare.prepare(self.data)

    def test_rejects_collection_output_or_wrong_owner_marker(self):
        with self.assertRaises(prepare.PrepareError):
            prepare.prepare({**self.data, "output": str(self.fixture.root)})
        with self.assertRaises(prepare.PrepareError):
            prepare.prepare({**self.data, "token": "b" * 32})
        target = self.output / "occupied.jpg"
        target.write_bytes(b"keep")
        with self.assertRaises(prepare.PrepareError):
            prepare.prepare(self.data)
        self.assertEqual(target.read_bytes(), b"keep")

    def test_output_and_pixel_budgets_fail_explicitly(self):
        with patch.object(prepare, "MAX_PIXELS", 10), self.assertRaises(prepare.PrepareError):
            prepare.prepare(self.data)
        with patch.object(prepare, "MAX_TOTAL_BYTES", 10), self.assertRaises(prepare.PrepareError):
            prepare.prepare(self.data)

    def test_cancel_does_not_read_or_write_source(self):
        prepare._cancelled = True
        with self.assertRaises(prepare.PrepareError) as error:
            prepare.prepare(self.data)
        self.assertEqual(error.exception.code, "caption_cancelled")
        self.assertEqual([p.name for p in self.output.iterdir()], [".owner"])

    def test_mixed_selection_uses_images_in_selected_order_without_video_decode(self):
        import edit_media
        crop_id = edit_media.execute(self.fixture.request)["mediaId"]
        crop_path = self.fixture.edit_path(crop_id)
        crop_bytes = crop_path.read_bytes()
        before = self.fixture.preserved()
        # The fixture video is deliberately not decodable. Common snapshot SHA
        # checks remain enabled, but caption preparation must never decode it.
        with patch.object(subprocess, "Popen", side_effect=AssertionError("No video process")), \
                patch.object(prepare, "normalize_image", wraps=prepare.normalize_image) as normalize:
            result = prepare.prepare({**self.data, "mediaIds": [crop_id, self.fixture.ids[1], self.fixture.ids[0]]})
        self.assertEqual([call.args[0] for call in normalize.call_args_list], [crop_path, self.fixture.originals[0]])
        self.assertEqual(result["images"], ["image-01.jpg", "image-02.jpg"])
        for filename, size in zip(result["images"], [(4, 5), (8, 12)]):
            with Image.open(self.output / filename) as image:
                self.assertEqual(image.size, size)
        self.assertEqual(crop_bytes, crop_path.read_bytes())
        self.assertEqual(before, self.fixture.preserved())

    def test_video_only_rejected_without_frame_or_output(self):
        before = self.fixture.preserved()
        with patch.object(subprocess, "Popen", side_effect=AssertionError("No video process")), \
                patch.object(prepare, "normalize_image") as normalize, \
                self.assertRaises(prepare.PrepareError) as error:
            prepare.prepare({**self.data, "mediaIds": [self.fixture.ids[1]]})
        self.assertEqual(error.exception.code, "caption_images_required")
        normalize.assert_not_called()
        self.assertEqual([p.name for p in self.output.iterdir()], [".owner"])
        self.assertEqual(before, self.fixture.preserved())

    def test_previously_captured_image_is_allowed_without_extracting_another_frame(self):
        import edit_media
        capture_id = edit_media.execute(self.fixture.capture_request())["mediaId"]
        capture_path = self.fixture.edit_path(capture_id)
        capture_bytes = capture_path.read_bytes()
        before = self.fixture.preserved()
        with patch.object(subprocess, "Popen", side_effect=AssertionError("No video process")):
            result = prepare.prepare({**self.data, "mediaIds": [self.fixture.ids[1], capture_id]})
        self.assertEqual(result["images"], ["image-01.jpg"])
        with Image.open(self.output / result["images"][0]) as image:
            self.assertEqual(image.size, (5, 4))
        self.assertEqual(capture_bytes, capture_path.read_bytes())
        self.assertEqual(before, self.fixture.preserved())

    def test_selection_limit_counts_all_refs_but_image_limit_counts_only_images(self):
        videos, paths = self.register_media(98)
        before_files = [path.read_bytes() for path in paths]
        before = self.fixture.preserved()
        selected = [self.fixture.ids[1], *videos, self.fixture.ids[0]]
        self.assertEqual(len(selected), 100)
        with patch.object(subprocess, "Popen", side_effect=AssertionError("No video process")):
            result = prepare.prepare({**self.data, "mediaIds": selected})
        self.assertEqual(result["images"], ["image-01.jpg"])
        self.assertEqual(before_files, [path.read_bytes() for path in paths])
        self.assertEqual(before, self.fixture.preserved())

    def test_twenty_images_allowed_but_twenty_one_rejected_before_preparation(self):
        ids, paths = self.register_media(20, kind="image")
        before_files = [path.read_bytes() for path in paths]
        before = self.fixture.preserved()
        with patch.object(prepare, "normalize_image") as normalize, self.assertRaises(prepare.PrepareError) as error:
            prepare.prepare({**self.data, "mediaIds": [self.fixture.ids[0], *ids]})
        self.assertEqual(error.exception.code, "caption_image_limit")
        normalize.assert_not_called()
        self.assertEqual([p.name for p in self.output.iterdir()], [".owner"])
        result = prepare.prepare({**self.data, "mediaIds": ids})
        self.assertEqual(result["images"], [f"image-{index:02d}.jpg" for index in range(1, 21)])
        self.assertEqual(before_files, [path.read_bytes() for path in paths])
        self.assertEqual(before, self.fixture.preserved())

    def test_cli_returns_safe_error_without_traceback_or_private_path(self):
        result = subprocess.run([sys.executable, "-I", "-B", str(Path(prepare.__file__))], input=json.dumps({**self.data, "mediaIds": ["invalid"]}), text=True, capture_output=True, check=True)
        value = json.loads(result.stdout)
        self.assertFalse(value["ok"])
        self.assertNotIn(str(self.fixture.root), result.stdout + result.stderr)
        self.assertEqual(result.stderr, "")


if __name__ == "__main__":
    unittest.main()
