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


def executable_x64(product=""):
    binary = bytearray(134)
    binary[:2] = b"MZ"
    binary[0x3C:0x40] = struct.pack("<I", 128)
    binary[128:] = b"PE\x00\x00\x64\x86"
    # Windows keeps the product name in the version resource as UTF-16.
    return bytes(binary) + product.encode("utf-16-le")


VARIANTS = release.load_variants()


def main_bundle(variant):
    """The shape webpack leaves: both values compiled in as string literals."""
    return (f'serviceBaseUrl("{variant["serviceUrl"]}",!0);https://update.electronjs.org;'
            f'repository:"{variant["updateRepository"]}"').encode()


class WindowsReleaseTests(unittest.TestCase):
    variant_name = "dev"

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.output = Path(self.temp.name)
        self.version = "0.1.1"
        self.variant = VARIANTS[self.variant_name]
        self.other = next(value for name, value in VARIANTS.items() if name != self.variant_name)
        self.repository = self.variant["updateRepository"]
        self.app_id = self.variant["squirrelName"]
        self.package = self.output / f"{self.app_id}-{self.version}-full.nupkg"
        self.contents = {
            "package.json": json.dumps({"name": "threads-media-manager", "version": self.version}).encode(),
            ".webpack/main/index.js": main_bundle(self.variant),
        }
        self.build()

    def build(self, app_id=None, nuspec_version=None, extra=None, setup_package=None,
              title=None, authors=None, executable_product=None):
        setup_package = setup_package or self.package.name
        (self.output / self.variant["setupExe"]).write_bytes(
            b"MZ synthetic installer PK\x03\x04" + setup_package.encode() + b"PK\x01\x02")
        with ZipFile(self.package, "w", ZIP_DEFLATED) as archive:
            archive.writestr(f"{self.app_id}.nuspec", f"""<package xmlns="urn:test">
                <metadata><id>{app_id or self.app_id}</id>
                <title>{title or self.variant["productName"]}</title>
                <version>{nuspec_version or self.version}</version>
                <authors>{authors or self.variant["companyName"]}</authors>
                </metadata></package>""")
            archive.writestr(f"lib/net45/{self.variant['executableName']}.exe",
                             executable_x64(executable_product or self.variant["productName"]))
            archive.writestr(release.ASAR_NAME, asar(self.contents))
            for name, data in (extra or {}).items():
                archive.writestr(name, data)
        data = self.package.read_bytes()
        self.feed = f"{hashlib.sha1(data).hexdigest()} {self.package.name} {len(data)}\n"
        (self.output / "RELEASES").write_text(self.feed, encoding="utf-8")

    def verify(self):
        return release.verify_release(self.output, self.version, self.variant_name)

    def test_accepts_correct_squirrel_release_and_shipped_feed(self):
        report = self.verify()
        self.assertEqual(report["variant"], self.variant_name)
        self.assertEqual(report["feedIntegrity"], "passed")
        self.assertEqual(report["appId"], self.app_id)
        self.assertEqual(report["repository"], self.repository)
        self.assertEqual(report["serviceUrl"], self.variant["serviceUrl"])
        self.assertEqual(report["fullPackage"], self.package.name)
        self.assertEqual(report["feed"], f"https://update.electronjs.org/{self.repository}/win32-x64/0.1.1")
        self.assertFalse(report["installerExecuted"])
        self.assertFalse(report["automaticUpdateTested"])

    def test_rejects_unknown_variant(self):
        for name in ["", "staging", None]:
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "Unknown build variant"):
                release.verify_release(self.output, self.version, name)

    def test_rejects_artifacts_of_the_other_variant(self):
        other_name = next(name for name in VARIANTS if name != self.variant_name)
        with self.assertRaisesRegex(ValueError, "Missing Windows installer"):
            release.verify_release(self.output, self.version, other_name)

    def test_requires_exactly_this_variants_service_url(self):
        service = self.variant["serviceUrl"]
        for shipped in ["", "https://threads-admin.example.test", f"{service}.example.test",
                        f"{service}:8443", service.replace("https://", "https://x")]:
            with self.subTest(shipped=shipped):
                self.contents[".webpack/main/index.js"] = main_bundle({**self.variant, "serviceUrl": shipped})
                self.build()
                with self.assertRaisesRegex(ValueError, "intended service URL"):
                    self.verify()

    def test_rejects_the_other_variants_service_url(self):
        for extra in [f'"{self.other["serviceUrl"]}"', f'fetch("{self.other["serviceUrl"]}/api/v1")']:
            with self.subTest(extra=extra):
                self.contents[".webpack/main/index.js"] = main_bundle(self.variant) + extra.encode()
                self.build()
                with self.assertRaisesRegex(ValueError, "another variant's service URL"):
                    self.verify()

    def test_rejects_the_other_variants_update_repository(self):
        other = self.other["updateRepository"]
        for extra in [f'"{other}"', f'"https://github.com/{other}/releases"']:
            with self.subTest(extra=extra):
                self.contents[".webpack/main/index.js"] = main_bundle(self.variant) + extra.encode()
                self.build()
                with self.assertRaisesRegex(ValueError, "another variant's update repository"):
                    self.verify()

    def test_rejects_only_the_other_variants_update_repository(self):
        self.contents[".webpack/main/index.js"] = main_bundle({**self.variant, "updateRepository": self.other["updateRepository"]})
        self.build()
        with self.assertRaisesRegex(ValueError, "intended public GitHub feed"):
            self.verify()

    def test_rejects_setup_built_from_another_package(self):
        cases = {
            "another version": f"{self.app_id}-0.1.0-full.nupkg",
            "another variant": f"{self.other['squirrelName']}-{self.version}-full.nupkg",
        }
        for label, name in cases.items():
            with self.subTest(label=label):
                self.build(setup_package=name)
                with self.assertRaisesRegex(ValueError, "this variant's full package"):
                    self.verify()
        self.build(setup_package=f"{self.package.name} {cases['another variant']}")
        with self.assertRaisesRegex(ValueError, "another variant's package"):
            self.verify()

    def test_rejects_the_other_variants_application_in_the_package(self):
        self.build(extra={f"lib/net45/{self.other['executableName']}.exe": executable_x64()})
        with self.assertRaisesRegex(ValueError, "another variant's application"):
            self.verify()

    def test_rejects_an_application_built_as_the_other_variant(self):
        # The other variant's executable renamed into this package keeps its own product name.
        self.build(executable_product=self.other["productName"])
        with self.assertRaisesRegex(ValueError, "product name"):
            self.verify()

    def test_rejects_the_other_variants_installed_program_name(self):
        for field in ["title", "authors"]:
            with self.subTest(field=field):
                self.build(**{field: self.other["productName"]})
                with self.assertRaisesRegex(ValueError, "title or authors"):
                    self.verify()

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
        self.contents[".webpack/main/index.js"] = main_bundle(
            {**self.variant, "updateRepository": "example/local-video-manager"})
        self.build()
        with self.assertRaisesRegex(ValueError, "intended public GitHub feed"):
            self.verify()

    def test_rejects_missing_update_runtime(self):
        self.contents[".webpack/main/index.js"] = main_bundle(self.variant).replace(b"update.electronjs.org", b"")
        self.build()
        with self.assertRaisesRegex(ValueError, "intended public GitHub feed"):
            self.verify()

    def test_rejects_user_data_and_credentials_outside_asar(self):
        for name in ["lib/net45/resources/auth.json", "lib/net45/resources/state/state.db",
                     "lib/net45/resources/.env", "lib/net45/resources/threads-account.json",
                     "lib/net45/resources/meta-token-checks.log"]:
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
        (self.output / self.variant["setupExe"]).write_text("not a windows exe")
        with self.assertRaisesRegex(ValueError, "PE executable"):
            self.verify()

    def test_rejects_prerelease_version_for_public_feed(self):
        with self.assertRaisesRegex(ValueError, "stable"):
            release.verify_release(self.output, "0.1.1-beta.1", self.variant_name)

    def test_rejects_non_x64_app(self):
        original = globals()["executable_x64"]
        try:
            # Machine field of the PE header (offset 132): x86 instead of x64.
            globals()["executable_x64"] = lambda product="": (
                original(product)[:132] + b"\x4c\x01" + original(product)[134:])
            self.build()
        finally:
            globals()["executable_x64"] = original
        with self.assertRaisesRegex(ValueError, "Windows x64"):
            self.verify()

    def test_rejects_malformed_variant_values(self):
        for key, value, message in [("updateRepository", "", "owner/repository"),
                                    ("serviceUrl", "http://127.0.0.1:4191", "HTTPS origin"),
                                    ("serviceUrl", self.variant["serviceUrl"] + "/", "HTTPS origin")]:
            with self.subTest(key=key, value=value), self.assertRaisesRegex(ValueError, message):
                release.verify_release(self.output, self.version, self.variant_name,
                                       {**VARIANTS, self.variant_name: {**self.variant, key: value}})


class ProdWindowsReleaseTests(WindowsReleaseTests):
    variant_name = "prod"


class VariantValueTests(unittest.TestCase):
    def test_dev_keeps_the_released_install_identity(self):
        # Installed dev copies update in place only while these stay exactly as released.
        dev = VARIANTS["dev"]
        self.assertEqual(dev["squirrelName"], "threads_media_manager")
        self.assertEqual(dev["setupExe"], "ThreadsMediaManager-win32-x64-Setup.exe")
        self.assertEqual(dev["executableName"], "ThreadsMediaManager")
        self.assertEqual(dev["updateRepository"], "ilseong-xofl/threads-media-manager")
        self.assertEqual(dev["serviceUrl"], "https://threads-admin-dev.ilscp.net")

    def test_whole_name_search_separates_the_overlapping_repositories(self):
        dev, prod = VARIANTS["dev"]["updateRepository"], VARIANTS["prod"]["updateRepository"]
        self.assertTrue(prod.startswith(dev))
        self.assertFalse(release.has_name(f'repository:"{prod}"', dev))
        self.assertFalse(release.has_literal(f'repository:"{prod}"', dev))
        self.assertTrue(release.has_name(f'"https://github.com/{dev}/releases"', dev))
        self.assertTrue(release.has_literal(f"repository:'{dev}'", dev))


if __name__ == "__main__":
    unittest.main()
