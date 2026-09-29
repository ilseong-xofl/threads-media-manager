"""Synthetic release artifacts: no installer execution, secrets or network."""
import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import unittest
from zipfile import ZIP_DEFLATED, ZipFile

SPEC = importlib.util.spec_from_file_location(
    "windows_release", Path(__file__).resolve().parents[1] / "scripts/verify-windows-release.py")
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


def asar(contents):
    files, payload = {}, b""
    for path, value in contents.items():
        parts = path.split("/")
        folder = files
        for part in parts[:-1]:
            folder = folder.setdefault(part, {"files": {}})["files"]
        folder[parts[-1]] = {"size": len(value), "offset": str(len(payload))}
        payload += value
    header = json.dumps({"files": files}).encode()
    pickle_body = struct.pack("<I", len(header)) + header
    pickle_body += bytes((-len(pickle_body)) % 4)
    pickle_header = struct.pack("<I", len(pickle_body)) + pickle_body
    return struct.pack("<II", 4, len(pickle_header)) + pickle_header + payload


def executable_x64():
    binary = bytearray(134)
    binary[:2] = b"MZ"
    binary[0x3C:0x40] = struct.pack("<I", 128)
    binary[128:] = b"PE\x00\x00\x64\x86"
    return bytes(binary)


class WindowsReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.output = Path(self.temp.name)
        self.version = "0.1.1"
        self.repository = "example/threads-media-manager"
        self.package = self.output / f"threads_media_manager-{self.version}-full.nupkg"
        self.contents = {
            "package.json": json.dumps({"name": "threads-media-manager", "version": self.version}).encode(),
            ".webpack/main/index.js": f"{self.repository} https://update.electronjs.org".encode(),
        }
        self.build()

    def build(self, app_id="threads_media_manager", nuspec_version=None, extra=None):
        (self.output / release.SETUP_NAME).write_bytes(b"MZ synthetic installer")
        with ZipFile(self.package, "w", ZIP_DEFLATED) as archive:
            archive.writestr("threads_media_manager.nuspec", f"""<package xmlns="urn:test">
                <metadata><id>{app_id}</id><version>{nuspec_version or self.version}</version>
                </metadata></package>""")
            archive.writestr("lib/net45/ThreadsMediaManager.exe", executable_x64())
            archive.writestr(release.ASAR_NAME, asar(self.contents))
            for name, data in (extra or {}).items():
                archive.writestr(name, data)
        data = self.package.read_bytes()
        self.feed = f"{hashlib.sha1(data).hexdigest()} {self.package.name} {len(data)}\n"
        (self.output / "RELEASES").write_text(self.feed, encoding="utf-8")

    def verify(self):
        return release.verify_release(self.output, self.version, self.repository)

    def test_accepts_correct_squirrel_release_and_shipped_feed(self):
        report = self.verify()
        self.assertEqual(report["feedIntegrity"], "passed")
        self.assertEqual(report["appId"], "threads_media_manager")
        self.assertEqual(report["feed"], "https://update.electronjs.org/example/threads-media-manager/win32-x64/0.1.1")
        self.assertFalse(report["installerExecuted"])
        self.assertFalse(report["automaticUpdateTested"])

    def test_rejects_stale_release_feed(self):
        (self.output / "RELEASES").write_text(self.feed.replace("0.1.1", "0.1.0"))
        with self.assertRaisesRegex(ValueError, "different app or version"):
            self.verify()

    def test_rejects_tampered_package_checksum(self):
        data = bytearray(self.package.read_bytes())
        data[40] ^= 1
        self.package.write_bytes(data)
        with self.assertRaisesRegex(ValueError, "SHA-1"):
            self.verify()

    def test_rejects_incorrect_package_size(self):
        (self.output / "RELEASES").write_text(self.feed.rsplit(" ", 1)[0] + " 1\n")
        with self.assertRaisesRegex(ValueError, "size"):
            self.verify()

    def test_rejects_multiple_feed_lines(self):
        (self.output / "RELEASES").write_text(self.feed * 2)
        with self.assertRaisesRegex(ValueError, "exactly"):
            self.verify()

    def test_rejects_other_application_id(self):
        self.build(app_id="local_video_manager")
        with self.assertRaisesRegex(ValueError, "ID mismatch"):
            self.verify()

    def test_rejects_nuget_version_mismatch(self):
        self.build(nuspec_version="0.1.0")
        with self.assertRaisesRegex(ValueError, "NuGet version"):
            self.verify()

    def test_rejects_shipped_app_version_mismatch(self):
        self.contents["package.json"] = b'{"name":"threads-media-manager","version":"0.1.0"}'
        self.build()
        with self.assertRaisesRegex(ValueError, "Shipped package version"):
            self.verify()

    def test_rejects_missing_built_update_repository(self):
        self.contents[".webpack/main/index.js"] = b"https://update.electronjs.org example/local-video-manager"
        self.build()
        with self.assertRaisesRegex(ValueError, "intended public GitHub feed"):
            self.verify()

    def test_rejects_missing_update_runtime(self):
        self.contents[".webpack/main/index.js"] = self.repository.encode()
        self.build()
        with self.assertRaisesRegex(ValueError, "intended public GitHub feed"):
            self.verify()

    def test_rejects_user_data_and_credentials_outside_asar(self):
        for name in ["lib/net45/resources/auth.json", "lib/net45/resources/state/state.db",
                     "lib/net45/resources/.env", "lib/net45/resources/threads-account.json"]:
            with self.subTest(name=name):
                self.build(extra={name: b"synthetic private fixture"})
                with self.assertRaisesRegex(ValueError, "User data or credentials"):
                    self.verify()

    def test_rejects_credentials_inside_asar(self):
        self.contents["auth.json"] = b"synthetic private fixture"
        self.build()
        with self.assertRaisesRegex(ValueError, "User data or credentials"):
            self.verify()

    def test_rejects_archive_path_traversal(self):
        self.build(extra={"../escape.txt": b"fixture"})
        with self.assertRaisesRegex(ValueError, "Unsafe archive path"):
            self.verify()

    def test_rejects_unexpected_release_assets(self):
        (self.output / "debug.log").write_text("fixture")
        with self.assertRaisesRegex(ValueError, "Unexpected release artifact"):
            self.verify()

    def test_rejects_non_executable_setup(self):
        (self.output / release.SETUP_NAME).write_text("not a windows exe")
        with self.assertRaisesRegex(ValueError, "PE executable"):
            self.verify()

    def test_rejects_prerelease_version_for_public_feed(self):
        with self.assertRaisesRegex(ValueError, "stable"):
            release.verify_release(self.output, "0.1.1-beta.1", self.repository)

    def test_rejects_non_x64_app(self):
        original = globals()["executable_x64"]
        try:
            globals()["executable_x64"] = lambda: original()[:-2] + b"\x4c\x01"
            self.build()
        finally:
            globals()["executable_x64"] = original
        with self.assertRaisesRegex(ValueError, "Windows x64"):
            self.verify()

    def test_rejects_missing_repository(self):
        with self.assertRaisesRegex(ValueError, "owner/repository"):
            release.verify_release(self.output, self.version, "")


if __name__ == "__main__":
    unittest.main()
