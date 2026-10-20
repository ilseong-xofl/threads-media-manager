"""WebP upload copies become PNG through the app's own Pillow; no network or library access."""
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "local-runtime"))
import convert_upload_image as convert

WORKER = Path(__file__).resolve().parents[1] / "local-runtime" / "convert_upload_image.py"


class ConvertUploadImageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="tmm-convert-")
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name).resolve()
        self.source = self.directory / "2.webp"
        self.destination = self.directory / "2.png"

    def write_webp(self, image, **options):
        image.save(self.source, format="WEBP", **options)

    def request(self):
        return {"source": str(self.source), "destination": str(self.destination)}

    def converted(self):
        raw = self.destination.read_bytes()
        self.assertTrue(raw.startswith(b"\x89PNG\r\n\x1a\n"))
        image = Image.open(io.BytesIO(raw))
        self.assertEqual(image.format, "PNG")
        return image

    def test_lossy_webp_becomes_png_with_the_same_dimensions(self):
        self.write_webp(Image.new("RGB", (64, 48), (200, 40, 20)), quality=80)
        convert.convert_request(self.request())
        image = self.converted()
        self.assertEqual((image.size, image.mode), ((64, 48), "RGB"))

    def test_transparency_is_preserved(self):
        image = Image.new("RGBA", (8, 8), (10, 20, 30, 255))
        image.putpixel((0, 0), (0, 0, 0, 0))
        self.write_webp(image, lossless=True)
        convert.convert_request(self.request())
        result = self.converted()
        self.assertEqual(result.mode, "RGBA")
        self.assertEqual(result.getpixel((0, 0))[3], 0)
        self.assertEqual(result.getpixel((1, 1)), (10, 20, 30, 255))

    def test_exif_orientation_is_applied_and_metadata_is_not_copied(self):
        exif = Image.Exif()
        exif[0x0112] = 6
        self.write_webp(Image.new("RGB", (40, 20), "white"), exif=exif.tobytes())
        convert.convert_request(self.request())
        image = self.converted()
        self.assertEqual(image.size, (20, 40))
        self.assertNotIn("exif", image.info)

    def test_content_that_is_not_webp_is_rejected_without_output(self):
        Image.new("RGB", (4, 4)).save(self.source, format="PNG")
        with self.assertRaises(convert.ConvertError) as caught:
            convert.convert_request(self.request())
        self.assertEqual(caught.exception.code, "convert_invalid_image")
        self.assertFalse(self.destination.exists())

    def test_pixel_limit_is_checked_before_decoding(self):
        self.write_webp(Image.new("RGB", (20, 20)))
        with patch.object(convert, "MAX_PIXELS", 399):
            with self.assertRaises(convert.ConvertError) as caught:
                convert.convert_request(self.request())
        self.assertEqual(caught.exception.code, "convert_image_limit")
        self.assertFalse(self.destination.exists())

    def test_request_must_name_a_webp_and_png_in_the_same_directory(self):
        self.write_webp(Image.new("RGB", (4, 4)))
        other = Path(tempfile.mkdtemp(prefix="tmm-convert-other-"))
        self.addCleanup(lambda: other.rmdir())
        for request in (
            {"source": str(self.source)},
            {**self.request(), "extra": True},
            {"source": "2.webp", "destination": "2.png"},
            {"source": str(self.source), "destination": str(self.directory / "2.jpg")},
            {"source": str(self.directory / "2.png"), "destination": str(self.destination)},
            {"source": str(self.source), "destination": str(other / "2.png")},
        ):
            with self.subTest(request=request), self.assertRaises(convert.ConvertError) as caught:
                convert.convert_request(request)
            self.assertEqual(caught.exception.code, "convert_request")
        self.assertFalse(self.destination.exists())

    def run_worker(self, request):
        completed = subprocess.run(
            [sys.executable, "-I", "-B", str(WORKER)],
            input=json.dumps(request).encode("utf-8"), capture_output=True, timeout=60, check=False,
        )
        return completed.returncode, json.loads(completed.stdout.decode("utf-8"))

    def test_worker_reports_success_and_specific_failures_as_json(self):
        self.write_webp(Image.new("RGB", (6, 4), "blue"))
        self.assertEqual(self.run_worker(self.request()), (0, {"ok": True}))
        self.assertEqual(self.converted().size, (6, 4))
        before = self.destination.read_bytes()
        status, result = self.run_worker(self.request())
        self.assertEqual(status, 1)
        self.assertFalse(result["ok"])
        self.assertRegex(result["error"]["code"], r"^[a-z_]{1,64}$")
        self.assertTrue(result["error"]["message"])
        self.assertEqual(self.destination.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
