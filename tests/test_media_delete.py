"""Synthetic-only deletion scope, workbook preservation, and crash recovery."""
from contextlib import closing
from datetime import datetime, timedelta
import hashlib
import io
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import unittest
from unittest.mock import patch
import zipfile

import test_media_edit as fixtures
from test_collection_source import payload, workbook

import delete_media as deletion
from threads_runner import deletion_state, inspection
from threads_runner.state import StateError
from threads_source import excel_input as excel, workbook_write
from threads_source.files import CollectionLock, SourceError


class MediaDeleteTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.MediaEditTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.root = self.fixture.root
        self.source = self.fixture.source
        self.editor = fixtures.editor
        self.view = fixtures.view
        self.request = {"root": str(self.root), "kind": "post", "postKey": self.fixture.key, "command": "prepare"}

    def edit(self):
        return self.editor.execute(self.fixture.request)["mediaId"]

    def edit_request(self, media_id):
        return {**self.request, "kind": "edit", "mediaId": media_id}

    def prepared(self, request=None):
        request = request or self.request
        result = deletion.execute(request)
        self.assertTrue(result["ok"])
        return {**request, "command": "commit", "fingerprint": result["fingerprint"]}

    def db_rows(self):
        with closing(sqlite3.connect(self.root / "state/state.db")) as db:
            tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            return {name: db.execute(f"SELECT * FROM {name}").fetchall()
                    for name in ("jobs", "media", "requests", "meta", "media_edits") if name in tables}

    def no_pending(self):
        self.assertFalse(deletion_state.deletion_pending(self.root))
        self.assertFalse((self.root / "_work/collector.lock").exists())

    def files(self):
        return {path.relative_to(self.root).as_posix(): path.read_bytes()
                for path in self.root.rglob("*") if path.is_file() and "state" not in path.relative_to(self.root).parts}

    def pending_folder(self):
        return next((self.root / "_work").glob("delete-"+"?"*32))

    def crash(self, request, *, after_commit=False, wal=False):
        code = """
import json, os, sys
sys.path.insert(0, sys.argv[1])
import delete_media as d
request = json.loads(sys.argv[2])
original = d.apply_tombstone
def crash(root, document):
    if sys.argv[4] == 'yes':
        blocker = d.open_db(root, 'rw')
        blocker.execute('BEGIN')
        blocker.execute('SELECT * FROM meta').fetchall()
    if sys.argv[3] == 'yes': original(root, document)
    os._exit(91)
d.apply_tombstone = crash
d.execute(request)
"""
        process = subprocess.run([sys.executable, "-I", "-B", "-c", code,
            str(Path(deletion.__file__).parent), json.dumps(request), "yes" if after_commit else "no", "yes" if wal else "no"],
            capture_output=True, text=True, timeout=20)
        self.assertEqual(process.returncode, 91, process.stdout+process.stderr)
        self.assertTrue(deletion_state.deletion_pending(self.root))
        return self.pending_folder()

    def recover(self):
        return deletion.execute({"command": "recover", "root": str(self.root)})

    def test_prepare_is_read_only_and_names_concrete_target(self):
        self.edit()
        before = self.files()
        database = (self.root / "state/state.db").read_bytes()
        result = deletion.execute(self.request)
        self.assertEqual((result["account"], result["postId"], result["fileCount"], result["editCount"]), ("Example", "AbC_01", 3, 1))
        self.assertRegex(result["fingerprint"], r"^[a-f0-9]{64}$")
        self.assertEqual(self.files(), before)
        self.assertEqual((self.root / "state/state.db").read_bytes(), database)
        self.no_pending()

    def test_edit_delete_preserves_originals_jobs_excel_and_recrop_child(self):
        first = self.edit()
        child = self.editor.execute({**self.fixture.request, "mediaId": first,
            "crop": {"x": 0, "y": 0, "width": 2, "height": 3}})["mediaId"]
        before = self.db_rows()
        original = self.fixture.preserved()
        self.assertEqual(deletion.execute(self.prepared(self.edit_request(first))), {"ok": True})
        self.assertFalse(self.fixture.edit_path(first).exists())
        self.assertTrue(self.fixture.edit_path(child).exists())
        self.assertEqual(self.db_rows(), before)
        self.assertEqual(self.fixture.preserved(), original)
        snapshot = self.fixture.snapshot()
        self.assertEqual([item["mediaId"] for item in snapshot["snapshot"]["posts"][0]["edits"]], [child])
        self.assertEqual(len(snapshot["files"]), 3)
        destination = self.fixture.base / "kept.zip"
        fixtures.export_post.export_post({"root": str(self.root), "postKey": self.fixture.key, "destination": str(destination)})
        with zipfile.ZipFile(destination) as archive:
            self.assertEqual(archive.namelist(), ["01.png", "02.mp4", "03.png", "게시글정보.txt"])
            self.assertEqual(archive.read("03.png"), self.fixture.edit_path(child).read_bytes())
        self.no_pending()

    def test_post_deletes_all_files_marks_every_observation_and_preserves_workbook_parts(self):
        first = self.edit()
        data = payload("RunB", "2026-09-22")
        data["posts"][0]["영상 수"] = 1
        data["media"].append({**data["media"][0], "순서": 2, "종류": "video"})
        second = self.root / "results/2026/09/threads-2026-09-22.xlsx"
        workbook(second, {"게시글": [data["posts"][0], dict(data["posts"][0])], "미디어": data["media"], "실행기록": [data["run"]]})
        second.write_bytes(workbook_write.patch_workbook(second.read_bytes(), {"게시글": [(7, {"사용자 메모": "메모\n보존"}), (8, {"사용자 메모": "다른 값"})]}))
        before = {path: path.read_bytes() for path in (self.source, second)}
        old_parsed = {path: excel.read_workbook(path) for path in before}
        old_db = self.db_rows()
        outside = self.fixture.base / "already-exported.zip"
        outside.write_bytes(b"unrelated previous export")
        unregistered = self.root / "media/files" / self.fixture.library / ("f"*32+".png")
        unregistered.write_bytes(b"unregistered preserve")
        result = deletion.execute(self.prepared())
        self.assertTrue(result["ok"])
        self.assertTrue(all(not path.exists() for path in self.fixture.originals))
        self.assertFalse(self.fixture.edit_path(first).exists())
        self.assertEqual(outside.read_bytes(), b"unrelated previous export")
        self.assertEqual(unregistered.read_bytes(), b"unregistered preserve")
        self.assertEqual(self.db_rows(), old_db)
        for path in before:
            after = excel.read_workbook(path)
            for key in ("posts", "media", "runs", "errors"):
                self.assertEqual(after[key], old_parsed[path][key])
            rows = excel._read_tables(path, {"게시글": ("계정명", "게시글ID", "삭제여부", "삭제시각(KST)")})["게시글"]
            self.assertTrue(all(row["삭제여부"] == "Y" for row in rows))
            self.assertTrue(all(datetime.fromisoformat(row["삭제시각(KST)"]).utcoffset() == timedelta(hours=9) for row in rows))
            with zipfile.ZipFile(io.BytesIO(before[path])) as old, zipfile.ZipFile(path) as new:
                self.assertEqual(old.namelist(), new.namelist())
                for name in old.namelist():
                    if name != "xl/worksheets/sheet1.xml": self.assertEqual(old.read(name), new.read(name))
        notes = excel._read_tables(second, {"게시글": ("계정명", "게시글ID", "사용자 메모")})["게시글"]
        self.assertEqual([row["사용자 메모"] for row in notes], ["메모\n보존", "다른 값"])
        self.assertEqual(self.fixture.snapshot()["snapshot"]["posts"], [])
        self.assertIn(("Example", "AbC_01"), deletion_state.deleted_posts(self.root))
        inspection.read_status(self.root)  # Removed bytes are deletion history, not corruption.
        self.no_pending()

    def test_missing_registered_edit_is_zero_files_but_can_be_tombstoned(self):
        media_id = self.edit()
        self.fixture.edit_path(media_id).unlink()
        request = self.edit_request(media_id)
        self.assertEqual(deletion.execute(request)["fileCount"], 0)
        deletion.execute(self.prepared(request))
        self.assertEqual(self.fixture.snapshot()["snapshot"]["posts"][0]["edits"], [])
        self.no_pending()

    def test_missing_original_is_allowed_but_changed_original_is_not(self):
        self.fixture.originals[0].unlink()
        self.assertEqual(deletion.execute(self.request)["fileCount"], 1)
        deletion.execute(self.prepared())
        self.assertFalse(self.fixture.originals[1].exists())
        self.no_pending()

    def test_tampered_bytes_never_deleted(self):
        media_id = self.edit()
        path = self.fixture.edit_path(media_id)
        path.write_bytes(b"changed bytes")
        before = self.files()
        with self.assertRaisesRegex(deletion.DeleteError, "변경"):
            deletion.execute(self.edit_request(media_id))
        self.assertEqual(self.files(), before)
        self.no_pending()

    def test_confirmed_plan_is_invalid_after_new_edit_or_excel_change(self):
        prepared = self.prepared()
        self.edit()
        with self.assertRaises(deletion.DeleteError) as error: deletion.execute(prepared)
        self.assertEqual(error.exception.code, "deletion_changed")
        prepared = self.prepared()
        self.source.write_bytes(workbook_write.patch_workbook(self.source.read_bytes(), {"게시글": [(7, {"사용자 메모": "changed"})]}))
        with self.assertRaises(deletion.DeleteError) as error: deletion.execute(prepared)
        self.assertEqual(error.exception.code, "deletion_changed")
        self.assertTrue(all(path.exists() for path in self.fixture.originals))
        self.no_pending()

    def test_any_unfinished_download_plan_blocks_post_deletion_without_policy_reset(self):
        with closing(sqlite3.connect(self.root / "state/state.db")) as db, db:
            db.execute("UPDATE jobs SET status='planned' WHERE media_id=?", (self.fixture.ids[1],))
        before = self.db_rows()
        with self.assertRaises(deletion.DeleteError) as error: deletion.execute(self.request)
        self.assertEqual(error.exception.code, "pending_download_plan")
        self.assertEqual(self.db_rows(), before)
        self.no_pending()

    def test_live_and_foreign_locks_are_not_recovered_or_removed(self):
        with CollectionLock(self.root):
            raw = (self.root / "_work/collector.lock").read_bytes()
            with self.assertRaises((SourceError, deletion.DeleteError)): deletion.execute(self.request)
            with self.assertRaises(deletion.DeleteError): self.recover()
            self.assertEqual((self.root / "_work/collector.lock").read_bytes(), raw)
        with deletion.DeleteLock(self.root):
            with self.assertRaises(deletion.DeleteError): self.recover()
        self.no_pending()

    def test_file_symlink_hardlink_and_database_symlink_are_rejected(self):
        media_id = self.edit()
        path = self.fixture.edit_path(media_id)
        original = path.read_bytes()
        external = self.fixture.base / "external.png"
        external.write_bytes(original)
        path.unlink()
        path.symlink_to(external)
        with self.assertRaises((SourceError, deletion.DeleteError)): deletion.execute(self.edit_request(media_id))
        self.assertEqual(external.read_bytes(), original)
        path.unlink()
        os.link(external, path)
        with self.assertRaises((SourceError, deletion.DeleteError)): deletion.execute(self.edit_request(media_id))
        path.unlink()
        path.write_bytes(original)
        database = self.root / "state/state.db"
        moved = self.fixture.base / "external.db"
        database.rename(moved)
        database.symlink_to(moved)
        with self.assertRaises((SourceError, deletion.DeleteError)): deletion.execute(self.edit_request(media_id))
        self.assertTrue(moved.exists())

    def test_invalid_registered_path_and_original_as_edit_are_rejected(self):
        with self.assertRaises(deletion.DeleteError) as error:
            deletion.execute(self.edit_request(self.fixture.ids[0]))
        self.assertEqual(error.exception.code, "edit_missing")
        media_id = self.edit()
        with closing(sqlite3.connect(self.root / "state/state.db")) as db, db:
            db.execute("UPDATE media_edits SET final_rel='../outside.png' WHERE edit_id=?", (media_id,))
        with self.assertRaises(deletion.DeleteError): deletion.execute(self.edit_request(media_id))
        self.assertTrue(self.fixture.edit_path(media_id).exists())
        self.no_pending()

    def test_cancel_after_quarantine_restores_every_original_byte(self):
        self.edit()
        prepared = self.prepared()
        before = self.files()
        rows = self.db_rows()
        def cancelled(): return not self.fixture.originals[0].exists()
        with self.assertRaises(deletion.DeleteError) as error: deletion.execute(prepared, check=cancelled)
        self.assertEqual(error.exception.code, "cancelled")
        self.assertEqual(self.files(), before)
        self.assertEqual(self.db_rows(), rows)
        self.no_pending()

    def test_cancel_after_excel_write_restores_excel_files_and_all_rows(self):
        prepared = self.prepared()
        before = self.files()
        rows = self.db_rows()
        raw = self.source.read_bytes()
        with self.assertRaises(deletion.DeleteError) as error:
            deletion.execute(prepared, check=lambda: self.source.read_bytes() != raw)
        self.assertEqual(error.exception.code, "cancelled")
        self.assertEqual(self.files(), before)
        self.assertEqual(self.db_rows(), rows)
        self.no_pending()

    def test_second_workbook_failure_rolls_back_first_workbook_and_media(self):
        second = self.root / "results/2026/09/threads-2026-09-22.xlsx"
        data = payload("RunB", "2026-09-22")
        data["posts"][0]["영상 수"] = 1
        data["media"].append({**data["media"][0], "순서": 2, "종류": "video"})
        workbook(second, {"게시글": data["posts"], "미디어": data["media"], "실행기록": [data["run"]]})
        prepared = self.prepared()
        before = self.files()
        real = deletion.write_atomic
        calls = 0
        def fail_second(path, raw):
            nonlocal calls
            if path.suffix == ".xlsx":
                calls += 1
                if calls == 2: raise OSError("simulated failed write")
            return real(path, raw)
        with patch.object(deletion, "write_atomic", side_effect=fail_second):
            with self.assertRaises(OSError): deletion.execute(prepared)
        self.assertEqual(self.files(), before)
        self.no_pending()

    def test_database_commit_uncertain_exception_uses_receipt_and_finishes(self):
        prepared = self.prepared()
        real = deletion.apply_tombstone
        def committed_then_raised(root, document):
            real(root, document)
            raise OSError("simulated post-commit interruption")
        with patch.object(deletion, "apply_tombstone", side_effect=committed_then_raised):
            self.assertTrue(deletion.execute(prepared)["ok"])
        self.assertTrue(all(not path.exists() for path in self.fixture.originals))
        self.assertEqual(self.fixture.snapshot()["snapshot"]["posts"], [])
        self.no_pending()

    def test_crash_before_database_commit_recovers_workbooks_files_and_history(self):
        self.edit()
        prepared = self.prepared()
        before = self.files()
        rows = self.db_rows()
        self.crash(prepared)
        with self.assertRaises((StateError, SourceError)): inspection.read_status(self.root)
        with self.assertRaises(StateError): self.editor.execute(self.fixture.request)
        destination = self.fixture.base / "blocked.zip"
        with self.assertRaises(StateError):
            fixtures.export_post.export_post({"root": str(self.root), "postKey": self.fixture.key, "destination": str(destination)})
        self.assertFalse(destination.exists())
        self.assertEqual(self.recover(), {"ok": True, "recovered": 1})
        after = self.files()
        after.pop("_work/delete-recovery.guard")
        self.assertEqual(after, before)
        self.assertEqual(self.db_rows(), rows)
        self.no_pending()

    def test_crash_after_committed_wal_cleans_files_without_resurrecting_post(self):
        prepared = self.prepared()
        rows = self.db_rows()
        folder = self.crash(prepared, after_commit=True, wal=True)
        self.assertGreater((self.root / "state/state.db-wal").stat().st_size, 0)
        self.assertTrue(list(folder.glob("file-*.bin")))
        self.assertEqual(self.recover(), {"ok": True, "recovered": 1})
        self.assertFalse(folder.exists())
        self.assertTrue(all(not path.exists() for path in self.fixture.originals))
        self.assertEqual(self.db_rows(), rows)
        self.assertEqual(self.fixture.snapshot()["snapshot"]["posts"], [])
        self.no_pending()

    def test_recovery_rejects_changed_journal_or_quarantined_bytes(self):
        folder = self.crash(self.prepared())
        journal = folder / "journal.json"
        raw = journal.read_bytes()
        document = json.loads(raw)
        document["postId"] = "tampered"
        journal.write_text(json.dumps(document))
        with self.assertRaises(deletion.DeleteError): self.recover()
        self.assertTrue(list(folder.glob("file-*.bin")))
        journal.write_bytes(raw)
        slot = folder / "file-0.bin"
        original = slot.read_bytes()
        slot.write_bytes(b"unexpected file")
        with self.assertRaises(deletion.DeleteError): self.recover()
        self.assertEqual(slot.read_bytes(), b"unexpected file")
        slot.write_bytes(original)
        self.assertEqual(self.recover()["recovered"], 1)
        self.no_pending()

    def test_recovery_preserves_external_excel_change_until_restored(self):
        folder = self.crash(self.prepared())
        current = self.source.read_bytes()
        changed = workbook_write.patch_workbook(current, {"게시글": [(7, {"캡션": "external change"})]})
        self.source.write_bytes(changed)
        with self.assertRaises(deletion.DeleteError): self.recover()
        self.assertEqual(self.source.read_bytes(), changed)
        self.assertTrue(folder.exists())
        self.source.write_bytes(current)
        self.assertEqual(self.recover()["recovered"], 1)
        self.no_pending()

    def test_recovery_serializes_and_cleans_only_dead_delete_lock(self):
        code = """import os,sys;sys.path.insert(0,sys.argv[1]);import delete_media as d;from pathlib import Path;d.DeleteLock(Path(sys.argv[2])).__enter__();os._exit(92)"""
        process = subprocess.run([sys.executable, "-I", "-B", "-c", code, str(Path(deletion.__file__).parent), str(self.root)], timeout=10)
        self.assertEqual(process.returncode, 92)
        self.assertTrue(deletion_state.abandoned_deletion(self.root))
        with deletion.recovery_guard(self.root):
            with self.assertRaises(deletion.DeleteError) as error: self.recover()
            self.assertEqual(error.exception.code, "busy")
        self.assertEqual(self.recover(), {"ok": True, "recovered": 0})
        self.no_pending()

    def test_absent_database_does_not_initialize_download_state(self):
        empty = self.fixture.base / "without-db"
        source = empty / "results/2026/09/threads-2026-09-21.xlsx"
        source.parent.mkdir(parents=True)
        source.write_bytes(self.source.read_bytes())
        with self.assertRaises(deletion.DeleteError) as error:
            deletion.execute({**self.request, "root": str(empty)})
        self.assertEqual(error.exception.code, "deletion_state_unavailable")
        self.assertFalse((empty / "state").exists())
        self.assertFalse((empty / "media").exists())

    def test_killed_journal_temporary_write_never_publishes_partial_journal(self):
        prepared = self.prepared()
        raw = self.source.read_bytes()
        code = """
import json,os,sys
sys.path.insert(0,sys.argv[1])
import delete_media as d
real=d.write_new
def crash(path,raw):
    if path.name.startswith('.delete-restore-'):
        with path.open('xb') as stream:
            stream.write(raw[:10]);stream.flush();os.fsync(stream.fileno())
        os._exit(93)
    return real(path,raw)
d.write_new=crash
d.execute(json.loads(sys.argv[2]))
"""
        process = subprocess.run([sys.executable, "-I", "-B", "-c", code,
            str(Path(deletion.__file__).parent), json.dumps(prepared)], capture_output=True, timeout=20)
        self.assertEqual(process.returncode, 93, process.stderr)
        self.assertFalse(deletion_state.deletion_pending(self.root))
        self.assertTrue(deletion_state.abandoned_deletion(self.root))
        self.assertEqual(self.recover(), {"ok": True, "recovered": 0})
        self.assertEqual(self.source.read_bytes(), raw)
        self.assertTrue(all(path.exists() for path in self.fixture.originals))
        self.assertEqual(len(self.fixture.snapshot()["snapshot"]["posts"]), 1)
        self.no_pending()

    def test_crash_between_journal_publication_and_registration_preserves_originals(self):
        prepared = self.prepared()
        before = self.files()
        code = """
import json,os,sys
sys.path.insert(0,sys.argv[1])
import delete_media as d
d.register_operation=lambda *args: os._exit(94)
d.execute(json.loads(sys.argv[2]))
"""
        process = subprocess.run([sys.executable, "-I", "-B", "-c", code,
            str(Path(deletion.__file__).parent), json.dumps(prepared)], capture_output=True, timeout=20)
        self.assertEqual(process.returncode, 94, process.stderr)
        self.assertTrue(deletion_state.deletion_pending(self.root))
        self.assertEqual(self.recover(), {"ok": True, "recovered": 1})
        after = self.files()
        after.pop("_work/delete-recovery.guard")
        self.assertEqual(after, before)
        self.no_pending()

    def test_partial_committed_cleanup_is_resumable_and_never_rolls_back(self):
        prepared = self.prepared()
        real = Path.unlink
        def fail_one(path, *args, **kwargs):
            if path.name == "file-1.bin": raise PermissionError("simulated cleanup failure")
            return real(path, *args, **kwargs)
        with patch.object(Path, "unlink", fail_one):
            with self.assertRaises(PermissionError): deletion.execute(prepared)
        folder = self.pending_folder()
        self.assertFalse((folder/"file-0.bin").exists())
        self.assertTrue((folder/"file-1.bin").exists())
        self.assertTrue(all(not path.exists() for path in self.fixture.originals))
        self.assertEqual(self.recover(), {"ok": True, "recovered": 1})
        self.assertEqual(self.fixture.snapshot()["snapshot"]["posts"], [])
        self.no_pending()

    def test_cli_prepare_commit_recover_and_invalid_eof(self):
        def run(data):
            process = subprocess.run([sys.executable, "-I", "-B", deletion.__file__],
                input=json.dumps(data).encode() if data is not None else b"", capture_output=True, timeout=20)
            self.assertEqual(process.stderr, b"")
            return process.returncode, json.loads(process.stdout)
        code, prepared = run(self.request)
        self.assertEqual(code, 0)
        code, result = run({**self.request, "command": "commit", "fingerprint": prepared["fingerprint"]})
        self.assertEqual((code, result), (0, {"ok": True}))
        self.assertEqual(run({"command": "recover", "root": str(self.root)}), (0, {"ok": True, "recovered": 0}))
        code, result = run(None)
        self.assertEqual(code, 1)
        self.assertEqual(result["error"]["code"], "invalid_request")


if __name__ == "__main__": unittest.main()
