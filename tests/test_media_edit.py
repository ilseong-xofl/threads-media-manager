"""Pixel-level edit persistence, original preservation, and read-only export tests."""
import base64
from contextlib import closing
import hashlib
import io
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
import uuid
from unittest.mock import patch
import zipfile

from PIL import Image, ImageOps, PngImagePlugin

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "local-runtime"))
import collection_view as view
import edit_media as editor
import export_post
from threads_runner import inspection
from threads_runner.state import State
from threads_source.files import CollectionLock, SourceError
from test_collection_source import payload, workbook


class MediaEditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name).resolve()
        self.root = self.base / "자료"
        self.root.mkdir()
        self.source = self.root / "results/2026/09/threads-2026-09-21.xlsx"
        data = payload()
        data["posts"][0]["영상 수"] = 1
        data["media"].append({**data["media"][0], "순서": 2, "종류": "video"})
        workbook(self.source, {"게시글": data["posts"], "미디어": data["media"], "실행기록": [data["run"]]})
        original = Image.new("RGB", (12, 8))
        original.putdata([(x*17, y*23, 100) for y in range(8) for x in range(12)])
        exif = Image.Exif()
        exif[274] = 6
        output = io.BytesIO()
        original.save(output, format="PNG", exif=exif)
        self.raw_image = output.getvalue()
        self.originals = []
        self.ids = ["a"*32, "b"*32]
        with State(self.root) as state:
            self.library = state.meta("library_id")
            for ordinal, (media_id, kind, extension, raw) in enumerate(zip(self.ids,
                    ("image", "video"), ("png", "mp4"), (self.raw_image, b"synthetic-video-file")), 1):
                relative = f"media/files/{'c'*32}/{media_id}.{extension}"
                path = self.root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(raw)
                self.originals.append(path)
                job = f"{ordinal:032x}"
                with state.db:
                    state.db.execute("INSERT INTO media VALUES(?,?,?,?,?)", (media_id, "Example", "AbC_01", ordinal, kind))
                    state.db.execute("""INSERT INTO jobs(job_id,media_id,source_rel,source_sha256,source_type,run_id,url_hash,status,final_rel,size,sha256,updated_at)
                        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""", (job, media_id, "source", "d"*64, "xlsx", "RunA", "e"*64,
                        "complete", relative, len(raw), hashlib.sha256(raw).hexdigest(), 1))
                    state.db.execute("INSERT INTO requests(job_id,url_hash,hostname,hop,consumed_at) VALUES(?,?,?,?,?)", (job, "e"*64, "example.test", 0, 1))
            with state.db:
                state.set_meta("next_allowed", 2_000_000_000)
                state.set_meta("stop", {"code": "prior_stop", "requires_review": True})
        self.key = '["Example","AbC_01"]'
        self.request = {"root": str(self.root), "postKey": self.key, "mediaId": self.ids[0], "kind": "crop",
            "crop": {"x": 2, "y": 3, "width": 4, "height": 5}}
        self.before = self.preserved()

    def tearDown(self): self.temp.cleanup()

    def preserved(self):
        with closing(sqlite3.connect(self.root / "state/state.db")) as db:
            tables = {name: db.execute(f"SELECT * FROM {name}").fetchall() for name in ("jobs", "media", "requests", "meta")}
            versions = (db.execute("PRAGMA application_id").fetchone()[0], db.execute("PRAGMA user_version").fetchone()[0])
        return {"source": self.source.read_bytes(), "originals": [path.read_bytes() for path in self.originals],
            "tables": tables, "versions": versions}

    def snapshot(self): return view.read_snapshot(self.root)

    def frame(self, size=(5, 4), format="PNG"):
        image = Image.new("RGBA" if format == "PNG" else "RGB", size, (40, 80, 120, 155) if format == "PNG" else (40, 80, 120))
        output = io.BytesIO()
        metadata = PngImagePlugin.PngInfo()
        metadata.add_text("comment", "private metadata")
        image.save(output, format=format, **({"pnginfo": metadata} if format == "PNG" else {}))
        return base64.b64encode(output.getvalue()).decode("ascii")

    def capture_request(self, **updates):
        return {"root": str(self.root), "postKey": self.key, "mediaId": self.ids[1], "kind": "capture",
            "pngBase64": self.frame(), "time": 1.25, **updates}

    def edit_path(self, media_id): return self.root / f"media/files/{self.library}/{media_id}.png"

    def test_exif_crop_pixels_append_and_existing_rows_unchanged(self):
        result = editor.execute(self.request)
        self.assertTrue(result["ok"])
        with Image.open(io.BytesIO(self.raw_image)) as image:
            expected = ImageOps.exif_transpose(image).crop((2, 3, 6, 8))
        with Image.open(self.edit_path(result["mediaId"])) as image:
            self.assertEqual(image.format, "PNG")
            self.assertEqual(image.size, (4, 5))
            self.assertEqual(image.tobytes(), expected.tobytes())
            self.assertEqual(dict(image.getexif()), {})
        snapshot = self.snapshot()
        post = snapshot["snapshot"]["posts"][0]
        self.assertEqual(len(post["attachments"]), 2)
        self.assertEqual([item["status"] for item in post["attachments"]], ["saved", "saved"])
        self.assertEqual(post["edits"][0]["ordinal"], 3)
        self.assertEqual(post["edits"][0]["editType"], "crop")
        self.assertEqual(post["edits"][0]["sourceMediaId"], self.ids[0])
        self.assertEqual(len(snapshot["files"]), 3)
        self.assertEqual(self.before, self.preserved())
        self.assertFalse((self.root / "_work/collector.lock").exists())

    def test_capture_normalizes_png_and_recrop_keeps_creation_order(self):
        first = editor.execute(self.capture_request())
        with Image.open(self.edit_path(first["mediaId"])) as image:
            self.assertEqual(image.size, (5, 4))
            self.assertEqual(image.mode, "RGBA")
            self.assertEqual(image.getpixel((0, 0)), (40, 80, 120, 155))
            self.assertNotIn("comment", image.info)
        second = editor.execute({**self.request, "mediaId": first["mediaId"], "crop": {"x": 1, "y": 0, "width": 2, "height": 3}})
        edits = self.snapshot()["snapshot"]["posts"][0]["edits"]
        self.assertEqual([item["mediaId"] for item in edits], [first["mediaId"], second["mediaId"]])
        self.assertEqual([item["ordinal"] for item in edits], [3, 4])
        self.assertEqual(edits[1]["sourceMediaId"], first["mediaId"])
        self.assertEqual(self.before, self.preserved())

    def test_zip_appends_edits_after_all_originals(self):
        first = editor.execute(self.request)
        second = editor.execute(self.capture_request())
        destination = self.base / "AbC_01.zip"
        result = export_post.export_post({"root": str(self.root), "postKey": self.key, "destination": str(destination)})
        self.assertTrue(result["ok"])
        with zipfile.ZipFile(destination) as archive:
            self.assertEqual(archive.namelist(), ["01.png", "02.mp4", "03.png", "04.png", "게시글정보.txt"])
            self.assertEqual(archive.read("01.png"), self.raw_image)
            self.assertEqual(archive.read("03.png"), self.edit_path(first["mediaId"]).read_bytes())
            self.assertEqual(archive.read("04.png"), self.edit_path(second["mediaId"]).read_bytes())

    def test_tampered_edit_is_review_but_original_status_and_download_state_stay_unchanged(self):
        before_download = inspection.read_status(self.root)
        result = editor.execute(self.request)
        self.edit_path(result["mediaId"]).write_bytes(b"tampered")
        snapshot = self.snapshot()
        post = snapshot["snapshot"]["posts"][0]
        self.assertEqual(post["edits"][0]["status"], "review")
        self.assertEqual([item["status"] for item in post["attachments"]], ["saved", "saved"])
        self.assertEqual(len(snapshot["files"]), 2)
        after_download = inspection.read_status(self.root)
        for key in ("problem", "nextAllowedAt", "jobs", "links"):
            self.assertEqual(before_download[key], after_download[key])
        with self.assertRaises(export_post.ExportError):
            export_post.export_post({"root": str(self.root), "postKey": self.key, "destination": str(self.base / "bad.zip")})
        self.assertEqual(self.before, self.preserved())

    def test_foreign_or_fake_lock_is_not_ignored(self):
        with CollectionLock(self.root):
            with self.assertRaises(SourceError): editor.execute(self.request)
            with self.assertRaises(SourceError): view.read_snapshot(self.root, owned_lock=object())
        self.assertEqual(self.before, self.preserved())

    def test_wrong_post_kind_missing_and_changed_source_are_rejected(self):
        requests = [{**self.request, "postKey": '["other","AbC_01"]'},
            {**self.request, "mediaId": self.ids[1]}, self.capture_request(mediaId=self.ids[0]),
            {**self.request, "mediaId": "f"*32}]
        for request in requests:
            with self.subTest(request=request), self.assertRaises(editor.EditError): editor.execute(request)
        self.originals[0].write_bytes(b"changed")
        with self.assertRaises(editor.EditError): editor.execute(self.request)
        self.assertFalse((self.root / f"media/files/{self.library}").exists())

    def test_crop_bounds_and_non_integer_values_are_rejected(self):
        for crop in ({"x": -1, "y": 0, "width": 1, "height": 1}, {"x": 0.5, "y": 0, "width": 1, "height": 1},
                     {"x": 0, "y": 0, "width": 0, "height": 1}, {"x": 7, "y": 0, "width": 2, "height": 1}):
            with self.subTest(crop=crop), self.assertRaises(editor.EditError): editor.execute({**self.request, "crop": crop})
        self.assertEqual(self.before, self.preserved())

    def test_capture_rejects_non_png_invalid_base64_truncation_and_size_limits(self):
        for value in ("!!!", self.frame(format="JPEG"), base64.b64encode(base64.b64decode(self.frame())[:30]).decode("ascii"), self.frame(size=(8193, 1))):
            with self.subTest(length=len(value)), self.assertRaises(editor.EditError): editor.execute(self.capture_request(pngBase64=value))
        with patch.object(editor, "MAX_PIXELS", 10), self.assertRaises(editor.EditError): editor.execute(self.capture_request())
        for time_value in (-1, float("nan"), float("inf"), True):
            with self.assertRaises(editor.EditError): editor.execute(self.capture_request(time=time_value))
        self.assertEqual(self.before, self.preserved())

    def test_symlink_source_or_output_folder_is_rejected(self):
        target = self.base / "original.png"
        self.originals[0].rename(target)
        self.originals[0].symlink_to(target)
        with self.assertRaises(editor.EditError): editor.execute(self.request)
        self.originals[0].unlink()
        target.rename(self.originals[0])
        folder = self.root / f"media/files/{self.library}"
        outside = self.base / "outside"
        outside.mkdir()
        folder.symlink_to(outside, target_is_directory=True)
        with self.assertRaises(SourceError): editor.execute(self.request)
        self.assertEqual(list(outside.iterdir()), [])
        self.assertEqual(self.before, self.preserved())

    def test_cancel_after_publish_rolls_back_record_and_removes_only_new_file(self):
        stopped = False
        def syncing(path):
            nonlocal stopped
            stopped = True
        with patch.object(editor, "sync_directory", side_effect=syncing), self.assertRaises(editor.EditError) as caught:
            editor.execute(self.request, check=lambda: stopped)
        self.assertEqual(caught.exception.code, "cancelled")
        self.assertEqual(self.snapshot()["snapshot"]["posts"][0]["edits"], [])
        self.assertEqual(list((self.root / "media/.partial").glob("*.edit.png")), [])
        self.assertEqual(list((self.root / f"media/files/{self.library}").glob("*.png")), [])
        self.assertEqual(self.before, self.preserved())

    def test_publication_error_keeps_originals_and_database_rows(self):
        with patch.object(editor.os, "link", side_effect=OSError("disk full")), self.assertRaises(OSError):
            editor.execute(self.request)
        self.assertEqual(self.before, self.preserved())
        self.assertEqual(self.snapshot()["snapshot"]["posts"][0]["edits"], [])
        self.assertEqual(list((self.root / "media/.partial").glob("*.edit.png")), [])

    def test_cli_isolated_mode_protocol_and_no_network(self):
        with patch("socket.create_connection", side_effect=AssertionError("No network")):
            result = editor.execute(self.capture_request())
            self.assertTrue(result["ok"])
        completed = subprocess.run([sys.executable, "-I", "-B", editor.__file__], input=json.dumps(self.request),
            text=True, capture_output=True, timeout=10)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertTrue(json.loads(completed.stdout)["ok"])
        self.assertEqual(completed.stderr, "")
        invalid = subprocess.run([sys.executable, "-I", "-B", editor.__file__], input="", text=True, capture_output=True, timeout=10)
        self.assertEqual(invalid.returncode, 1)
        self.assertFalse(json.loads(invalid.stdout)["ok"])

    def test_old_database_read_does_not_create_optional_edit_table(self):
        before_bytes = (self.root / "state/state.db").read_bytes()
        self.assertEqual(self.snapshot()["snapshot"]["posts"][0]["edits"], [])
        self.assertEqual((self.root / "state/state.db").read_bytes(), before_bytes)
        with closing(sqlite3.connect(self.root / "state/state.db")) as db:
            self.assertIsNone(db.execute("SELECT 1 FROM sqlite_master WHERE name='media_edits'").fetchone())

    def test_source_change_during_render_prevents_publishing(self):
        actual = editor.render
        def changed(*args):
            result = actual(*args)
            self.originals[0].write_bytes(b"Changed by another program")
            return result
        with patch.object(editor, "render", side_effect=changed), self.assertRaises(editor.EditError) as caught:
            editor.execute(self.request)
        self.assertEqual(caught.exception.code, "source_changed")
        self.assertFalse((self.root / f"media/files/{self.library}").exists())
        self.assertEqual(self.before["tables"], self.preserved()["tables"])

    def test_missing_edit_and_invalid_stored_path_leave_original_attachments_saved(self):
        result = editor.execute(self.request)
        path = self.edit_path(result["mediaId"])
        path.unlink()
        post = self.snapshot()["snapshot"]["posts"][0]
        self.assertEqual(post["edits"][0]["status"], "review")
        with closing(sqlite3.connect(self.root / "state/state.db")) as db, db:
            db.execute("UPDATE media_edits SET final_rel='../outside.png'")
        snapshot = self.snapshot()
        post = snapshot["snapshot"]["posts"][0]
        self.assertEqual(post["edits"][0]["status"], "review")
        self.assertEqual(post["edits"][0]["reason"], "invalid_edit")
        self.assertEqual([item["status"] for item in post["attachments"]], ["saved", "saved"])
        self.assertEqual(len(snapshot["files"]), 2)

    def test_generated_id_collision_preserves_all_existing_media(self):
        with patch.object(editor.uuid, "uuid4", return_value=uuid.UUID(self.ids[0])), self.assertRaises(editor.EditError) as caught:
            editor.execute(self.request)
        self.assertEqual(caught.exception.code, "edit_identity_conflict")
        self.assertEqual(self.before, self.preserved())

    def test_staged_png_tampering_rolls_back_record_and_removes_temp(self):
        actual = view.read_snapshot
        calls = 0
        def snapshot(*args, **kwargs):
            nonlocal calls
            calls += 1
            result = actual(*args, **kwargs)
            if calls == 3:
                next((self.root / "media/.partial").glob("*.edit.png")).write_bytes(b"tampered temporary file")
            return result
        with patch.object(view, "read_snapshot", side_effect=snapshot), self.assertRaises(editor.EditError) as caught:
            editor.execute(self.request)
        self.assertEqual(caught.exception.code, "edit_file_changed")
        self.assertEqual(self.before, self.preserved())
        self.assertEqual(list((self.root / "media/.partial").glob("*.edit.png")), [])

    def test_corrupt_edit_metadata_never_silently_omits_edits_from_zip(self):
        editor.execute(self.request)
        destination = self.base / "keep.zip"
        destination.write_bytes(b"existing export")
        for corruption, expected in (("UPDATE media_edits SET created_at='invalid date'", "invalid_edit"),
                                     ("ALTER TABLE media_edits RENAME COLUMN sequence TO broken_sequence", "edits_unavailable")):
            with self.subTest(corruption=corruption):
                with closing(sqlite3.connect(self.root / "state/state.db")) as db, db:
                    db.execute(corruption)
                snapshot = self.snapshot()
                self.assertIn(expected, [warning["code"] for warning in snapshot["snapshot"]["warnings"]])
                self.assertEqual([item["status"] for item in snapshot["snapshot"]["posts"][0]["attachments"]], ["saved", "saved"])
                with self.assertRaises(export_post.ExportError) as caught:
                    export_post.export_post({"root": str(self.root), "postKey": self.key, "destination": str(destination)})
                self.assertEqual(caught.exception.code, "edits_unavailable")
                self.assertIn("복구", str(caught.exception))
                self.assertEqual(destination.read_bytes(), b"existing export")


if __name__ == "__main__": unittest.main()
