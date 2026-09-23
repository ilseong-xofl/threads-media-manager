"""AI generations use stable references throughout development registration workflows."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import test_media_edit as fixtures
import ai_media
import caption_images
import collection_view as view
import export_post
import library_maintenance as maintenance
import post_draft


def generation(fixture, identifier="d"*32, created="2026-09-22T01:00:00.000Z", **changes):
    folder = ai_media.post_folder(fixture.key)
    path = fixture.root / "ai-drafts" / folder / identifier
    path.mkdir(parents=True)
    raw = fixture.raw_image
    (path / "01.png").write_bytes(raw)
    data = {"id": identifier, "postKey": fixture.key, "mediaIds": [fixture.ids[0]], "sourceImageCount": 1,
            "files": ["01.png"], "imageHashes": [hashlib.sha256(raw).hexdigest()], "aiGenerated": True,
            "status": "review", "createdAt": created, **changes}
    (path / "draft.json").write_text(json.dumps(data))
    return path, ai_media.media_id(folder, identifier, "01.png")


class AIMediaTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.MediaEditTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.root = self.fixture.root
        self.path, self.identifier = generation(self.fixture)
        self.request = {"root": str(self.root), "postKey": self.fixture.key,
                        "caption": "Reviewed local draft", "mediaIds": [self.identifier], "expectedRevision": None}
        self.before = self.fixture.preserved()

    def snapshot(self): return view.read_snapshot(self.root, include_ai=True)

    def post(self): return self.snapshot()["snapshot"]["posts"][0]

    def caption_request(self):
        temporary = tempfile.TemporaryDirectory(prefix="tmm-caption-")
        self.addCleanup(temporary.cleanup)
        path = Path(temporary.name).resolve()
        (path / ".owner").write_text("e"*32)
        return {"root": str(self.root), "postKey": self.fixture.key, "mediaIds": [self.identifier],
                "output": str(path), "token": "e"*32}

    def test_opt_in_all_versions_order_ids_and_no_latest_dependency(self):
        later, later_id = generation(self.fixture, "c"*32, "2026-09-23T01:00:00Z")
        (self.path.parent / "latest.json").write_text('{"id":"untrusted"}')
        pending = self.path.parent / (".pending-"+"f"*32)
        pending.mkdir()
        (pending / "draft.json").write_text("invalid")
        self.assertNotIn("aiImages", self.fixture.snapshot()["snapshot"]["posts"][0])
        post = self.post()
        self.assertEqual([item["mediaId"] for item in post["aiImages"]], [self.identifier, later_id])
        self.assertTrue(all(item["status"] == "saved" and item["aiGenerated"] is True for item in post["aiImages"]))
        self.assertEqual([item["ordinal"] for item in post["aiImages"]], [3, 4])
        self.assertEqual(self.fixture.preserved(), self.before)

    def test_mixed_registration_reload_new_generation_and_ordered_export(self):
        edit = fixtures.editor.execute(self.fixture.request)["mediaId"]
        selected = [self.identifier, edit, self.fixture.ids[0]]
        result = post_draft.execute({**self.request, "mediaIds": selected}, include_ai=True)
        _path, newer = generation(self.fixture, "e"*32, "2026-09-23T01:00:00Z")
        self.assertEqual(self.post()["draft"], result["draft"])
        self.assertNotIn(newer, self.post()["draft"]["mediaIds"])
        destination = self.fixture.base / "registered.zip"
        export_post.export_post({"root": str(self.root), "postKey": self.fixture.key,
                                 "destination": str(destination), "expectedRevision": 1}, include_ai=True)
        with zipfile.ZipFile(destination) as archive:
            self.assertEqual(archive.namelist(), ["01.png", "02.png", "03.png", "게시글정보.txt"])
            self.assertEqual(archive.read("01.png"), (self.path / "01.png").read_bytes())
            self.assertIn(b"Reviewed local draft", archive.read("게시글정보.txt"))
        normal = self.fixture.base / "original.zip"
        export_post.export_post({"root": str(self.root), "postKey": self.fixture.key,
                                 "destination": str(normal)}, include_ai=True)
        with zipfile.ZipFile(normal) as archive:
            self.assertEqual(archive.namelist(), ["01.png", "02.mp4", "03.png", "게시글정보.txt"])
        self.assertEqual(self.fixture.preserved(), self.before)

    def test_default_workers_reject_ai_and_input_cannot_enable_it(self):
        for request in (self.request, {**self.request, "include_ai": True}):
            with self.assertRaises(post_draft.DraftError): post_draft.execute(request)
        data = self.caption_request()
        with self.assertRaises(caption_images.PrepareError): caption_images.prepare({**data, "include_ai": True})
        post_draft.execute(self.request, include_ai=True)
        with self.assertRaises(export_post.ExportError):
            export_post.export_post({"root": str(self.root), "postKey": self.fixture.key,
                                     "destination": str(self.fixture.base / "blocked.zip"), "expectedRevision": 1})
        self.assertEqual(self.fixture.snapshot()["snapshot"]["posts"][0]["draft"]["mediaIds"], [self.identifier])

    def test_caption_input_uses_ai_and_original_only_stays_original(self):
        data = self.caption_request()
        with self.assertRaises(caption_images.PrepareError):
            caption_images.prepare({**data, "originalOnly": True}, include_ai=True)
        result = caption_images.prepare(data, include_ai=True)
        self.assertEqual(result["images"], ["image-01.jpg"])
        self.assertTrue((Path(data["output"]) / "image-01.jpg").exists())
        self.assertEqual(self.fixture.preserved(), self.before)

    def test_missing_or_changed_asset_keeps_registration_and_blocks_save_export(self):
        original = post_draft.execute(self.request, include_ai=True)["draft"]
        (self.path / "01.png").write_bytes(b"changed")
        post = self.post()
        self.assertEqual(post["draft"], original)
        self.assertEqual(post["aiImages"][0]["status"], "unavailable")
        self.assertIsNone(post["aiImages"][0]["localUrl"])
        with self.assertRaises(post_draft.DraftError):
            post_draft.execute({**self.request, "expectedRevision": 1}, include_ai=True)
        with self.assertRaises(export_post.ExportError):
            export_post.export_post({"root": str(self.root), "postKey": self.fixture.key,
                                     "destination": str(self.fixture.base / "blocked.zip"), "expectedRevision": 1}, include_ai=True)
        (self.path / "01.png").unlink()
        self.assertEqual(self.post()["draft"], original)
        self.assertEqual(self.post()["aiImages"][0]["status"], "unavailable")

    def test_foreign_manifest_paths_ids_and_markers_are_rejected(self):
        manifest = self.path / "draft.json"
        original = json.loads(manifest.read_text())
        for change in ({"postKey": '["Other","AbC_01"]'}, {"id": "f"*32},
                       {"files": ["../../outside.png"]}, {"files": ["02.png"]},
                       {"mediaIds": ["f"*32]}, {"aiGenerated": False}, {"status": "published"},
                       {"sourceImageCount": True}, {"createdAt": "not a date"}):
            with self.subTest(change=change):
                manifest.write_text(json.dumps({**original, **change}))
                snapshot = self.snapshot()
                self.assertEqual(snapshot["snapshot"]["posts"][0]["aiImages"], [])
                self.assertIn("ai_media_unavailable", [warning["code"] for warning in snapshot["snapshot"]["warnings"]])
        manifest.write_text(json.dumps(original))
        self.assertEqual(self.post()["aiImages"][0]["status"], "saved")

    def test_symlink_and_hardlink_assets_are_unavailable(self):
        outside = self.fixture.base / "outside.png"
        outside.write_bytes(self.fixture.raw_image)
        image = self.path / "01.png"
        image.unlink()
        image.symlink_to(outside)
        self.assertEqual(self.post()["aiImages"][0]["status"], "unavailable")
        image.unlink()
        os.link(outside, image)
        self.assertEqual(self.post()["aiImages"][0]["status"], "unavailable")
        self.assertEqual(outside.read_bytes(), self.fixture.raw_image)

    def test_generation_manifest_symlink_and_hardlink_are_not_read(self):
        manifest = self.path / "draft.json"
        outside = self.fixture.base / "manifest.json"
        outside.write_bytes(manifest.read_bytes())
        manifest.unlink()
        manifest.symlink_to(outside)
        self.assertEqual(self.post()["aiImages"], [])
        manifest.unlink()
        os.link(outside, manifest)
        self.assertEqual(self.post()["aiImages"], [])

    def test_cli_opt_in_is_explicit(self):
        script = Path(view.__file__)
        base = [sys.executable, "-I", "-B", str(script), "--collection-root", str(self.root)]
        default = subprocess.run(base, capture_output=True, text=True, check=True)
        dev = subprocess.run([*base, "--include-ai"], capture_output=True, text=True, check=True)
        self.assertNotIn("aiImages", json.loads(default.stdout)["snapshot"]["posts"][0])
        self.assertEqual(json.loads(dev.stdout)["snapshot"]["posts"][0]["aiImages"][0]["mediaId"], self.identifier)

    def test_worker_cli_flags_allow_registration_caption_and_registered_export(self):
        def run(module, data):
            process = subprocess.run([sys.executable, "-I", "-B", module.__file__, "--include-ai"],
                                     input=json.dumps(data), capture_output=True, text=True, timeout=15)
            self.assertEqual(process.returncode, 0, process.stderr + process.stdout)
            return json.loads(process.stdout)
        saved = run(post_draft, self.request)
        self.assertEqual(saved["draft"]["mediaIds"], [self.identifier])
        prepared = run(caption_images, self.caption_request())
        self.assertEqual(prepared["images"], ["image-01.jpg"])
        exported = run(export_post, {"root": str(self.root), "postKey": self.fixture.key,
                                    "destination": str(self.fixture.base / "cli.zip"), "expectedRevision": 1})
        self.assertTrue(exported["ok"])

    def test_caption_rechecks_generated_file_after_preparation(self):
        data = self.caption_request()
        normalize = caption_images.normalize_image
        def changed(source, destination):
            normalize(source, destination)
            source.write_bytes(b"replaced while preparing")
        with patch.object(caption_images, "normalize_image", side_effect=changed), self.assertRaises(view.SourceError):
            caption_images.prepare(data, include_ai=True)
        self.assertEqual(self.fixture.preserved(), self.before)

    def test_backup_restore_resolves_ai_from_existing_manifest(self):
        post_draft.execute(self.request, include_ai=True)
        backup = self.fixture.base / "backup.sqlite"
        def run(command, **rest):
            return maintenance.execute({"command": command, "root": str(self.root), "appVersion": "test", **rest})
        run("backup", path=str(backup))
        post_draft.execute({**self.request, "mediaIds": [self.fixture.ids[0]], "expectedRevision": 1})
        run("restore", path=str(backup))
        self.assertEqual(self.post()["draft"]["mediaIds"], [self.identifier])
        (self.path / "01.png").unlink()
        with self.assertRaises(maintenance.MaintenanceError): run("restore", path=str(backup))
