"""Offline checks for the Mac development CLI bundle, without user authentication."""
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/prepare-macos-codex.py'
spec = importlib.util.spec_from_file_location('macos_codex_runtime', SCRIPT)
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)
TARGET = 'aarch64-apple-darwin'


class MacCodexRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def archive(self, name, mode=0o644, kind=tarfile.REGTYPE):
        archive = self.root / 'codex.tgz'
        with tarfile.open(archive, 'w:gz') as tar:
            member = tarfile.TarInfo(name)
            member.mode = mode
            member.type = kind
            member.size = 5 if kind == tarfile.REGTYPE else 0
            member.linkname = '/outside' if kind == tarfile.SYMTYPE else ''
            tar.addfile(member, io.BytesIO(b'bytes') if member.size else None)
        return archive

    @unittest.skipIf(__import__('sys').platform == 'win32', 'POSIX executable permissions')
    def test_preserves_execution_without_special_permission_bits(self):
        archive = self.archive('package/vendor/' + TARGET + '/bin/codex', 0o4755)
        runtime.unpack(archive, self.root / 'out', TARGET)
        file = self.root / 'out/bin/codex'
        self.assertEqual(file.read_bytes(), b'bytes')
        self.assertEqual(file.stat().st_mode & 0o7777, 0o755)

    def test_rejects_traversal_and_symlinks(self):
        for name, kind in [('../escape', tarfile.REGTYPE), ('/escape', tarfile.REGTYPE),
                           ('package/vendor/' + TARGET + '/bin/codex', tarfile.SYMTYPE)]:
            with self.subTest(name=name):
                with self.assertRaises(RuntimeError):
                    runtime.unpack(self.archive(name, kind=kind), self.root / 'out', TARGET)

    def test_excludes_the_other_architecture(self):
        archive = self.archive('package/vendor/x86_64-apple-darwin/bin/codex')
        runtime.unpack(archive, self.root / 'out', TARGET)
        self.assertFalse((self.root / 'out').exists())

    @unittest.skipIf(__import__('sys').platform == 'win32', 'POSIX executable permissions')
    def test_cache_detects_missing_or_modified_dependencies_and_manifest_changes(self):
        output = self.root / 'runtime'
        for relative in runtime.REQUIRED:
            file = output / relative
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(b'fixture')
            file.chmod(0o755)
        metadata = {'layoutVersion': 1, 'version': '0.158.0', 'target': TARGET,
                    'variant': 'codex', 'entrypoint': 'bin/codex',
                    'resourcesDir': 'codex-resources', 'pathDir': 'codex-path'}
        (output / 'codex-package.json').write_text(json.dumps(metadata))
        (output / 'runtime-files.json').write_text(json.dumps({
            'fingerprint': 'expected', 'files': runtime.inventory(output)}))
        check = lambda fingerprint='expected': runtime.verified_cache(output, fingerprint, '0.158.0', TARGET)
        self.assertTrue(check())
        self.assertFalse(check('new-version'))
        executable = output / 'bin/codex'
        executable.write_bytes(b'tampered')
        self.assertFalse(check())
        executable.write_bytes(b'fixture')
        self.assertTrue(check())
        executable.chmod(0o644)
        self.assertFalse(check())
        executable.unlink()
        self.assertFalse(check())

    def test_rejects_download_with_an_unexpected_checksum(self):
        from unittest.mock import patch
        item = {'name': 'bad.tgz', 'url': 'https://invalid.example/fixture', 'sha256': '0' * 64}
        with patch.object(runtime.urllib.request, 'urlopen', return_value=io.BytesIO(b'wrong')):
            with self.assertRaisesRegex(RuntimeError, 'checksum'):
                runtime.download(item, self.root)


if __name__ == '__main__':
    unittest.main()
