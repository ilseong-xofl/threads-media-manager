"""Offline journal contract tests. Run with python -m unittest discover -s tests."""

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "plugins" / "threads-collector" / "scripts" / "collection_journal.py"
SPEC = importlib.util.spec_from_file_location("collection_journal", SCRIPT)
journal_module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(journal_module)


class CollectionJournalTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "run.jsonl"

    def event(self, kind, event_id=None, payload=None):
        return {"v": 1, "type": kind, "run_id": "run-한글", "account": "sample",
                "event_id": event_id or kind, "payload": payload or {}}

    def append(self, record):
        return journal_module.append_record(self.path, record)

    def start(self):
        self.append(self.event("start"))

    def assert_rejected_unchanged(self, record):
        before = self.path.read_bytes()
        with self.assertRaises(journal_module.JournalError):
            self.append(record)
        self.assertEqual(self.path.read_bytes(), before)

    def test_roundtrip_literal_caption_and_signed_url(self):
        self.start()
        payload = {"posts": [{"id": "D123", "caption": "한글 첫 줄\n둘째 줄 ☕\u2028끝",
                              "url": "https://cdn.example/media.mp4?x=a%2Bb&token=A_B-C&expires=123"}]}
        self.append(self.event("batch", payload=payload))
        self.append(self.event("end", payload={"status": "partial"}))
        raw = self.path.read_bytes()
        self.assertIn("한글".encode(), raw)
        self.assertEqual(raw.count(b"\n"), 3)
        snapshot = journal_module.read_journal(self.path)
        self.assertEqual(snapshot["records"][1]["payload"], payload)
        self.assertEqual([record["seq"] for record in snapshot["records"]], [1, 2, 3])
        self.assertTrue(snapshot["state"]["closed"])
        self.assertFalse(snapshot["recovery"]["incomplete_tail"])

    def test_incomplete_tail_reported_never_repaired(self):
        self.start()
        valid_length = self.path.stat().st_size
        fragment = b'{"caption":"' + "한".encode()[:2]
        with self.path.open("ab") as stream:
            stream.write(fragment)
        before = self.path.read_bytes()
        snapshot = journal_module.read_journal(self.path)
        self.assertEqual(len(snapshot["records"]), 1)
        self.assertEqual(snapshot["recovery"], {
            "incomplete_tail": True, "valid_bytes": valid_length, "tail_bytes": len(fragment),
            "total_bytes": len(before), "empty_journal": False})
        self.assertEqual(self.path.read_bytes(), before)
        self.assert_rejected_unchanged(self.event("batch"))
        self.assert_rejected_unchanged(self.event("start"))

    def test_valid_json_without_newline_is_also_incomplete(self):
        self.start()
        fragment = dict(self.event("batch"), seq=2)
        with self.path.open("ab") as stream:
            stream.write(json.dumps(fragment).encode())
        snapshot = journal_module.read_journal(self.path)
        self.assertTrue(snapshot["recovery"]["incomplete_tail"])
        self.assertEqual(len(snapshot["records"]), 1)

    def test_corrupt_complete_line_fails_even_with_later_valid_line(self):
        self.start()
        with self.path.open("ab") as stream:
            stream.write(b"not json\n")
            stream.write(json.dumps(dict(self.event("batch"), seq=3)).encode() + b"\n")
        with self.assertRaises(journal_module.JournalError):
            journal_module.read_journal(self.path)
        self.assert_rejected_unchanged(self.event("batch"))

    def test_identity_mismatch_and_repeated_start_rejected(self):
        self.start()
        for key in ("run_id", "account"):
            self.assert_rejected_unchanged(dict(self.event("batch"), **{key: "another"}))
        self.assert_rejected_unchanged(self.event("start", "different-start"))

    def test_closed_journal_rejects_new_events_but_allows_exact_retry(self):
        self.start()
        end = self.event("end")
        self.append(end)
        before = self.path.read_bytes()
        retry = self.append(end)
        self.assertEqual(retry["seq"], 2)
        self.assertTrue(retry["deduplicated"])
        self.assertEqual(self.path.read_bytes(), before)
        self.assert_rejected_unchanged(self.event("end", "second-end"))
        self.assert_rejected_unchanged(self.event("batch"))

    def test_retry_dedup_and_conflict_rejection(self):
        self.start()
        batch = self.event("batch", "dom-1", {"value": 1, "text": "원문"})
        self.append(batch)
        before = self.path.read_bytes()
        retry = dict(reversed(list(batch.items())))
        retry["payload"] = {"text": "원문", "value": 1}
        self.assertTrue(self.append(retry)["deduplicated"])
        self.assertTrue(self.append(self.event("start"))["deduplicated"])
        self.assertEqual(self.path.read_bytes(), before)
        # True and 1 must not compare as identical JSON event content.
        self.assert_rejected_unchanged(self.event("batch", "dom-1", {"value": True, "text": "원문"}))

    def test_helper_assigns_seq_and_nonconsecutive_persisted_seq_is_corruption(self):
        self.start()
        self.assert_rejected_unchanged(dict(self.event("batch"), seq=2))
        with self.path.open("ab") as stream:
            stream.write(json.dumps(dict(self.event("batch"), seq=3)).encode() + b"\n")
        with self.assertRaises(journal_module.JournalError):
            journal_module.read_journal(self.path)

    def test_invalid_input_preserves_file_and_does_not_create_new_journal(self):
        invalid = self.event("start", payload={"value": float("nan")})
        with self.assertRaises(journal_module.JournalError):
            self.append(invalid)
        self.assertFalse(self.path.exists())
        self.start()
        for value in (float("nan"), float("inf"), {1: "bad key"}, "\ud800"):
            self.assert_rejected_unchanged(self.event("batch", payload={"value": value}))
        self.assert_rejected_unchanged(dict(self.event("batch"), v=True))

    def test_new_batch_refused_and_existing_empty_file_preserved(self):
        with self.assertRaises(journal_module.JournalError):
            self.append(self.event("batch"))
        self.assertFalse(self.path.exists())
        self.path.touch()
        self.assertTrue(journal_module.read_journal(self.path)["recovery"]["empty_journal"])
        self.assert_rejected_unchanged(self.event("start"))

    def test_mixed_identity_and_records_after_end_are_corruption(self):
        self.start()
        first_bytes = self.path.read_bytes()
        for malformed in (dict(self.event("batch"), account="other", seq=2),
                          dict(self.event("start", "start-2"), seq=2)):
            self.path.write_bytes(first_bytes + json.dumps(malformed).encode() + b"\n")
            with self.assertRaises(journal_module.JournalError):
                journal_module.read_journal(self.path)
        self.path.write_bytes(first_bytes)
        self.append(self.event("end"))
        with self.path.open("ab") as stream:
            stream.write(json.dumps(dict(self.event("batch"), seq=3)).encode() + b"\n")
        with self.assertRaises(journal_module.JournalError):
            journal_module.read_journal(self.path)

    def test_duplicate_keys_nonfinite_and_overflow_json_rejected(self):
        for raw in (b'{"payload":1,"payload":2}', b'{"x":NaN}', b'{"x":1e999}'):
            with self.assertRaises(journal_module.JournalError):
                journal_module._decode(raw, "test")

    def test_write_error_stops_and_never_truncates_prior_data(self):
        self.start()
        before = self.path.read_bytes()
        with mock.patch.object(journal_module.os, "fsync", side_effect=OSError("simulated disk failure")):
            with self.assertRaises(journal_module.JournalError):
                self.append(self.event("batch"))
        self.assertTrue(self.path.read_bytes().startswith(before))

    def test_read_snapshot_cannot_overwrite_journal_or_hardlink(self):
        self.start()
        snapshot = journal_module.read_journal(self.path)
        before = self.path.read_bytes()
        with self.assertRaises(journal_module.JournalError):
            journal_module.write_snapshot(self.path, self.path, snapshot)
        hardlink = self.path.with_name("same-file.json")
        hardlink.hardlink_to(self.path)
        with self.assertRaises(journal_module.JournalError):
            journal_module.write_snapshot(self.path, hardlink, snapshot)
        self.assertEqual(self.path.read_bytes(), before)

    def test_cli_outputs_metadata_only_and_exports_records_to_file(self):
        record_path = self.path.with_name("input.json")
        record_path.write_text(json.dumps(self.event("start", payload={"url": "https://private.example/token"})), encoding="utf-8")
        result = subprocess.run([sys.executable, str(SCRIPT), "append", "--journal", str(self.path),
                                 "--input", str(record_path)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("private.example", result.stdout)
        output = self.path.with_name("snapshot.json")
        result = subprocess.run([sys.executable, str(SCRIPT), "read", "--journal", str(self.path),
                                 "--output", str(output)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("private.example", result.stdout)
        self.assertEqual(json.loads(result.stdout)["record_count"], 1)
        self.assertEqual(json.loads(output.read_text())["records"][0]["payload"]["url"], "https://private.example/token")


if __name__ == "__main__":
    unittest.main()
