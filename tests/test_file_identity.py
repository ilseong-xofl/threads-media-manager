"""Cross-API Windows timestamps must not reject unchanged local files."""
from pathlib import Path
import os
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "plugins/threads-collector/scripts"))
from threads_source import files


class FileIdentityTests(unittest.TestCase):
    def test_windows_birth_time_matches_when_stat_and_fstat_ctime_differ(self):
        fields = dict(st_dev=1, st_ino=2, st_size=3, st_mtime_ns=4, st_birthtime_ns=5)
        before = SimpleNamespace(**fields, st_ctime_ns=5)
        opened = SimpleNamespace(**fields, st_ctime_ns=99)
        self.assertEqual(files.stat_signature(before, windows=True), files.stat_signature(opened, windows=True))
        self.assertNotEqual(files.stat_signature(before, windows=False), files.stat_signature(opened, windows=False))

    def test_same_size_rewritten_file_can_be_read_on_windows(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory).resolve() / "한글 日本語.txt"
            path.write_bytes(b"before")
            path.write_bytes(b"after!")
            self.assertEqual(files.read_stable(path, max_bytes=1024), b"after!")

    def test_change_time_during_open_read_is_still_checked(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory).resolve() / "file"
            path.write_bytes(b"content")
            original = os.fstat
            calls = 0
            def changed(fd):
                nonlocal calls
                calls += 1
                value = original(fd)
                attrs = {name: getattr(value, name) for name in dir(value) if name.startswith("st_")}
                if calls > 1:
                    attrs["st_ctime_ns"] += 1
                return SimpleNamespace(**attrs)
            with patch.object(files.os, "fstat", side_effect=changed):
                with self.assertRaises(files.SourceError) as caught:
                    files.read_stable(path, max_bytes=1024)
            self.assertEqual(caught.exception.code, "source_changed")
