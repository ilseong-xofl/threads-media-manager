"""Local recovery preserves files, request history, waits, and deletion intent."""
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import unittest
from unittest.mock import patch

import test_media_edit as fixtures
import library_maintenance as maintenance
import post_draft
import save_post_comment
from threads_runner.state import State, StateError
from threads_source.files import CollectionLock


class LibraryMaintenanceTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.MediaEditTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.root = self.fixture.root
        self.backup = self.fixture.base / "백업.sqlite"
        self.db_path = self.root / "state/state.db"
        self.draft_request = {"root": str(self.root), "postKey": self.fixture.key, "caption": "backup caption",
                              "mediaIds": [self.fixture.ids[0]], "expectedRevision": None}
        post_draft.execute(self.draft_request)
        save_post_comment.execute({"root": str(self.root), "postKey": self.fixture.key,
                                   "caption": "backup reply", "link": "https://example.com/item"})

    def request(self, command, **values):
        return {"command": command, "root": str(self.root), "appVersion": "0.1.0-test", **values}

    def run_command(self, command, **values):
        return maintenance.execute(self.request(command, **values))

    def make_backup(self):
        return self.run_command("backup", path=str(self.backup))

    def add_retry_lineage(self, db):
        columns = [row[1] for row in db.execute("PRAGMA table_info(jobs)")]
        row = dict(zip(columns, db.execute("SELECT * FROM jobs WHERE job_id=?", ("1".zfill(32),)).fetchone()))
        row["job_id"] = "c" * 32
        db.execute(f"INSERT INTO jobs({','.join(columns)}) VALUES({','.join('?' for _ in columns)})", tuple(row.values()))
        db.execute("UPDATE jobs SET status='failed' WHERE job_id=?", ("1".zfill(32),))
        db.execute("CREATE TABLE job_attempts(previous_job_id TEXT PRIMARY KEY REFERENCES jobs(job_id),replacement_job_id TEXT UNIQUE REFERENCES jobs(job_id),reason TEXT,created_at REAL)")
        db.execute("INSERT INTO job_attempts VALUES(?,?,?,?)", ("1".zfill(32), row["job_id"], "interrupted", 100))

    def data(self):
        with closing(sqlite3.connect(self.db_path)) as db:
            return {name: db.execute(f"SELECT * FROM {name} ORDER BY 1").fetchall() for name in
                    ("meta", "jobs", "media", "requests", "post_drafts", "post_comments")}

    def media_bytes(self):
        return {path.relative_to(self.root).as_posix(): path.read_bytes()
                for path in (self.root / "media").rglob("*") if path.is_file()}

    def test_online_backup_manifest_and_all_tables_without_touching_original(self):
        original = self.data()
        media = self.media_bytes()
        result = self.make_backup()
        self.assertEqual(result["file_path"], str(self.backup))
        self.assertEqual(result["library_id"], self.fixture.library)
        with closing(sqlite3.connect(self.backup)) as db:
            self.assertEqual(maintenance.validate_db(db, backup=True)["library_id"], self.fixture.library)
            for name, rows in original.items():
                self.assertEqual(db.execute(f"SELECT * FROM {name} ORDER BY 1").fetchall(), rows)
        self.assertEqual(self.data(), original)
        self.assertEqual(self.media_bytes(), media)
        self.assertFalse(Path(str(self.backup) + "-wal").exists())

    def test_online_backup_includes_committed_wal_and_retry_lineage(self):
        with closing(sqlite3.connect(self.db_path)) as db:
            db.execute("PRAGMA journal_mode=WAL")
            with db:
                self.add_retry_lineage(db)
                db.execute("UPDATE post_drafts SET caption='committed in WAL'")
            self.assertTrue(Path(str(self.db_path) + "-wal").exists())
            self.make_backup()
            with closing(sqlite3.connect(self.backup)) as copy:
                self.assertEqual(copy.execute("SELECT caption FROM post_drafts").fetchone()[0], "committed in WAL")
                self.assertEqual(copy.execute("SELECT reason FROM job_attempts").fetchone()[0], "interrupted")
                maintenance.validate_db(copy, backup=True)

    def test_semantically_corrupt_attempt_history_backup_is_rejected(self):
        with closing(sqlite3.connect(self.db_path)) as db, db:
            self.add_retry_lineage(db)
        self.make_backup()
        before = self.data()
        with closing(sqlite3.connect(self.backup)) as db, db:
            db.execute("UPDATE job_attempts SET previous_job_id=replacement_job_id")
        with self.assertRaises(StateError) as failure:
            self.run_command("restore", path=str(self.backup))
        self.assertEqual(failure.exception.code, "invalid_attempt_history")
        self.assertEqual(before, self.data())

    def test_normal_restore_reverts_metadata_but_preserves_new_requests_waits_and_edits(self):
        self.make_backup()
        edit = fixtures.editor.execute(self.fixture.request)
        post_draft.execute({**self.draft_request, "caption": "new caption", "expectedRevision": 1,
                            "mediaIds": [edit["mediaId"]]})
        save_post_comment.execute({"root": str(self.root), "postKey": self.fixture.key,
                                   "caption": "new reply", "link": ""})
        with State(self.root) as state, state.db:
            state.set_meta("next_allowed", 3_000_000_000)
            state.set_meta("stop", {"code": "http_429", "requires_review": False})
            state.db.execute("INSERT INTO requests(job_id,url_hash,hostname,hop,consumed_at) VALUES(?,?,?,?,?)",
                             ("1".zfill(32), "f" * 64, "example.test", 0, 42))
        before = self.data()
        media = self.media_bytes()
        result = self.run_command("restore", path=str(self.backup))
        self.assertEqual(result["restore_mode"], "metadata")
        self.assertFalse(result["history_review_required"])
        after = self.data()
        for table in ("meta", "jobs", "media", "requests"):
            self.assertEqual(after[table], before[table])
        self.assertEqual(after["post_drafts"][0][2], "backup caption")
        self.assertEqual(after["post_drafts"][0][-1], 3)
        self.assertEqual(after["post_comments"][0][2], "backup reply")
        self.assertEqual(self.media_bytes(), media)
        with closing(sqlite3.connect(result["automatic_backup_path"])) as db:
            self.assertEqual(db.execute("SELECT caption FROM post_drafts").fetchone()[0], "new caption")
        with closing(sqlite3.connect(self.db_path)) as db:
            self.assertEqual(db.execute("SELECT edit_id FROM media_edits").fetchone()[0], edit["mediaId"])

    def test_normal_restore_keeps_deletions_and_does_not_restore_deleted_post(self):
        self.make_backup()
        with closing(sqlite3.connect(self.db_path)) as db, db:
            db.execute("CREATE TABLE post_deletions(account TEXT,post_id TEXT,deleted_at TEXT,PRIMARY KEY(account,post_id))")
            db.execute("INSERT INTO post_deletions VALUES('Example','AbC_01','2026-09-22')")
            db.execute("DELETE FROM post_drafts")
            db.execute("DELETE FROM post_comments")
        self.fixture.originals[0].unlink()
        result = self.run_command("restore", path=str(self.backup))
        self.assertEqual(result["restored_drafts"], 0)
        self.assertEqual(result["restored_comments"], 0)
        self.assertEqual(self.data()["post_drafts"], [])
        with closing(sqlite3.connect(self.db_path)) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM post_deletions").fetchone()[0], 1)

    def test_corrupt_and_foreign_backup_rejected_without_current_mutation(self):
        before = self.data()
        self.backup.write_bytes(b"invalid sqlite")
        with self.assertRaises(sqlite3.DatabaseError):
            self.run_command("restore", path=str(self.backup))
        self.assertEqual(self.data(), before)
        self.make_backup()
        with closing(sqlite3.connect(self.backup)) as db, db:
            db.execute("UPDATE meta SET value=? WHERE key='library_id'", (json.dumps("f" * 32),))
            db.execute("UPDATE backup_manifest SET library_id=?", ("f" * 32,))
        with self.assertRaisesRegex(maintenance.MaintenanceError, "같은 라이브러리"):
            self.run_command("restore", path=str(self.backup))
        self.assertEqual(self.data(), before)

    def test_unsupported_backup_and_active_input_wal_rejected(self):
        self.make_backup()
        before = self.data()
        Path(str(self.backup) + "-wal").write_bytes(b"active")
        with self.assertRaisesRegex(maintenance.MaintenanceError, "닫힌 백업"):
            self.run_command("restore", path=str(self.backup))
        Path(str(self.backup) + "-wal").unlink()
        with closing(sqlite3.connect(self.backup)) as db, db:
            db.execute("PRAGMA user_version=123")
        with self.assertRaises(maintenance.MaintenanceError):
            self.run_command("restore", path=str(self.backup))
        self.assertEqual(self.data(), before)

    def test_missing_db_full_restore_requires_history_review_and_keeps_original_files(self):
        self.make_backup()
        old = self.data()
        media = self.media_bytes()
        self.db_path.unlink()
        result = self.run_command("restore", path=str(self.backup))
        self.assertEqual(result["restore_mode"], "full")
        self.assertTrue(result["history_review_required"])
        self.assertNotIn("automatic_backup_path", result)
        now = self.data()
        for table in ("jobs", "requests", "media", "post_drafts", "post_comments"):
            self.assertEqual(now[table], old[table])
        meta = {key: json.loads(value) for key, value in now["meta"]}
        self.assertEqual(meta["stop"]["code"], "database_restored")
        self.assertEqual(meta["stop"]["previous_stop"]["code"], "prior_stop")
        self.assertEqual(meta["next_allowed"], 2_000_000_000)
        with State(self.root) as state, self.assertRaises(StateError): state.guard()
        self.assertEqual(self.media_bytes(), media)

    def test_corrupt_current_db_saved_raw_before_disaster_restore(self):
        self.make_backup()
        raw = b"broken sqlite original"
        self.db_path.write_bytes(raw)
        result = self.run_command("restore", path=str(self.backup))
        self.assertEqual(Path(result["automatic_backup_path"]).read_bytes(), raw)
        self.assertEqual(result["restore_mode"], "full")
        self.assertEqual(self.data()["post_drafts"][0][2], "backup caption")

    def test_failed_disaster_replace_keeps_corrupt_original_and_automatic_raw_copy(self):
        self.make_backup()
        self.db_path.write_bytes(b"original broken DB")
        real_replace = maintenance.os.replace
        def replace(source, target):
            if target == self.db_path: raise OSError("simulated disk failure")
            return real_replace(source, target)
        with patch.object(maintenance.os, "replace", side_effect=replace), self.assertRaises(OSError):
            self.run_command("restore", path=str(self.backup))
        self.assertEqual(self.db_path.read_bytes(), b"original broken DB")
        copies = list((self.root / "state/backups").glob("before-restore-*.sqlite"))
        self.assertEqual(len(copies), 1)
        self.assertEqual(copies[0].read_bytes(), b"original broken DB")
        self.assertFalse((self.root / "_work/collector.lock").exists())
        self.assertEqual(self.run_command("restore", path=str(self.backup))["restore_mode"], "full")

    def test_disaster_restore_missing_media_fails_before_replacing_corrupt_db(self):
        self.make_backup()
        self.db_path.write_bytes(b"broken current")
        self.fixture.originals[1].unlink()
        with self.assertRaises((maintenance.MaintenanceError, ValueError)):
            self.run_command("restore", path=str(self.backup))
        self.assertEqual(self.db_path.read_bytes(), b"broken current")

    def test_valid_foreign_current_db_is_never_overwritten(self):
        self.make_backup()
        with closing(sqlite3.connect(self.db_path)) as db, db:
            db.execute("UPDATE meta SET value=? WHERE key='library_id'", (json.dumps("f" * 32),))
        before = self.data()
        with self.assertRaises(maintenance.MaintenanceError) as error:
            self.run_command("restore", path=str(self.backup))
        self.assertEqual(error.exception.code, "library_mismatch")
        self.assertEqual(self.data(), before)

    def test_reconnect_moves_only_root_after_library_and_file_hash_validation(self):
        before = self.data()
        destination = self.fixture.base / "이동한 자료"
        self.root.rename(destination)
        self.root = destination
        self.db_path = destination / "state/state.db"
        result = self.run_command("reconnect")
        self.assertEqual(result["library_id"], self.fixture.library)
        after = self.data()
        for table in ("jobs", "requests", "media", "post_drafts", "post_comments"):
            self.assertEqual(before[table], after[table])
        before_meta = dict(before["meta"])
        after_meta = dict(after["meta"])
        self.assertEqual(json.loads(after_meta.pop("root")), str(destination))
        before_meta.pop("root")
        self.assertEqual(before_meta, after_meta)

    def test_connect_fresh_folder_does_not_create_database_or_library_marker(self):
        fresh = self.fixture.base / "새 수집 폴더"
        fresh.mkdir()
        result = maintenance.execute({"command": "reconnect", "root": str(fresh)})
        self.assertIsNone(result["library_id"])
        self.assertFalse((fresh / "state").exists())
        self.assertFalse((fresh / "media").exists())
        self.assertFalse((fresh / "_work/collector.lock").exists())

    def test_reconnect_missing_or_corrupt_db_preserves_files_and_allows_explicit_restore(self):
        self.make_backup()
        media = self.media_bytes()
        for original in (None, b"broken sqlite original"):
            with self.subTest(original=original):
                if original is None:
                    self.db_path.unlink()
                else:
                    self.db_path.write_bytes(original)
                self.assertEqual(self.run_command("reconnect")["library_id"], self.fixture.library)
                if original is None:
                    self.assertFalse(self.db_path.exists())
                else:
                    self.assertEqual(self.db_path.read_bytes(), original)
                snapshot = fixtures.view.read_snapshot(self.root)
                self.assertEqual(snapshot["snapshot"]["stateStatus"], "unavailable")
                self.assertEqual(self.run_command("restore", path=str(self.backup))["restore_mode"], "full")
                self.assertEqual(self.media_bytes(), media)

    def test_reconnect_rejects_foreign_or_unsupported_db_without_rewriting_it(self):
        original = self.db_path.read_bytes()
        for statement in (
                "PRAGMA application_id=42",
                "PRAGMA user_version=123",
                "UPDATE meta SET value='\"" + "f" * 32 + "\"' WHERE key='library_id'",
        ):
            with self.subTest(statement=statement):
                self.db_path.write_bytes(original)
                with closing(sqlite3.connect(self.db_path)) as db, db:
                    db.execute(statement)
                before = self.db_path.read_bytes()
                with self.assertRaises(maintenance.MaintenanceError):
                    self.run_command("reconnect")
                self.assertEqual(self.db_path.read_bytes(), before)

    def test_reconnect_wrong_file_and_wrong_marker_do_not_update_root(self):
        destination = self.fixture.base / "moved"
        self.root.rename(destination)
        self.root = destination
        self.db_path = destination / "state/state.db"
        original = self.data()
        moved_image = destination / self.fixture.originals[0].relative_to(self.fixture.root)
        raw = moved_image.read_bytes()
        moved_image.write_bytes(b"tampered")
        with self.assertRaises(maintenance.MaintenanceError): self.run_command("reconnect")
        self.assertEqual(original, self.data())
        moved_image.write_bytes(raw)
        marker = destination / "media/.library.json"
        marker.write_text(json.dumps({"schema_version": 1, "library_id": "f" * 32}))
        with self.assertRaises(maintenance.MaintenanceError): self.run_command("reconnect")
        self.assertEqual(original, self.data())

    def test_reconnect_preserves_interrupted_job_for_following_local_recovery(self):
        with closing(sqlite3.connect(self.db_path)) as db, db:
            db.execute("UPDATE jobs SET status='running' WHERE job_id=?", ("2".zfill(32),))
        destination = self.fixture.base / "moved-interrupted"
        self.root.rename(destination)
        self.root = destination
        self.db_path = destination / "state/state.db"
        original = self.data()
        self.run_command("reconnect")
        self.assertEqual(self.data()["jobs"], original["jobs"])

    def test_moved_library_with_dead_download_lock_can_reconnect_then_recover_locally(self):
        from threads_runner import runner
        part = self.root / "media/.partial/interrupted.part"
        part.write_bytes(b"incomplete transfer")
        with closing(sqlite3.connect(self.db_path)) as db, db:
            db.execute("UPDATE jobs SET status='running',part_rel=? WHERE job_id=?",
                       (part.relative_to(self.root).as_posix(), "2".zfill(32)))
        # A subprocess object is needed for an actual terminated PID.
        process = subprocess.Popen([sys.executable, "-c", "pass"])
        process.wait()
        lock = self.root / "_work/collector.lock"
        lock.write_text(json.dumps({"owner": "download-runner", "pid": process.pid, "token": "9" * 32}))
        destination = self.fixture.base / "moved-after-crash"
        self.root.rename(destination)
        self.root = destination
        self.db_path = destination / "state/state.db"
        before = self.data()
        self.run_command("reconnect")
        with patch("socket.create_connection", side_effect=AssertionError("No network")):
            runner.recover(self.root)
        after = self.data()
        self.assertEqual(before["requests"], after["requests"])
        self.assertEqual(after["jobs"][0][7], "complete")
        self.assertEqual(after["jobs"][1][7], "interrupted")
        self.assertEqual(json.loads(dict(after["meta"])["next_allowed"]), 2_000_000_000)
        self.assertFalse((self.root / "_work/collector.lock").exists())

    def test_moved_staged_file_can_finish_locally_without_downloading_again(self):
        from threads_runner import runner
        with closing(sqlite3.connect(self.db_path)) as db, db:
            db.execute("UPDATE jobs SET status='staged',part_rel=? WHERE job_id=?",
                       ("media/.partial/staged.part", "1".zfill(32)))
        destination = self.fixture.base / "moved-staged"
        self.root.rename(destination)
        self.root = destination
        self.db_path = destination / "state/state.db"
        before = self.data()
        self.run_command("reconnect")
        with patch("socket.create_connection", side_effect=AssertionError("No network")):
            result = runner.recover(self.root)
        self.assertEqual(result["network_requests"], 0)
        self.assertEqual(len(result["recovered"]), 1)
        self.assertEqual(self.data()["requests"], before["requests"])
        self.assertEqual(self.data()["jobs"][0][7], "complete")

    def test_missing_and_corrupt_db_still_exposes_collection_root_for_settings(self):
        self.db_path.unlink()
        missing = fixtures.view.read_snapshot(self.root)
        self.assertEqual(missing["snapshot"]["root"], str(self.root))
        self.assertEqual(missing["snapshot"]["stateStatus"], "unavailable")
        self.db_path.write_bytes(b"broken")
        broken = fixtures.view.read_snapshot(self.root)
        self.assertEqual(broken["snapshot"]["root"], str(self.root))
        self.assertEqual(broken["snapshot"]["stateStatus"], "unavailable")

    def test_active_collector_lock_blocks_all_maintenance(self):
        self.make_backup()
        before = self.data()
        with CollectionLock(self.root):
            for command in ("backup", "restore", "reconnect"):
                with self.assertRaises(maintenance.MaintenanceError) as error:
                    self.run_command(command, **({"path": str(self.backup)} if command != "reconnect" else {}))
                self.assertEqual(error.exception.code, "busy")
        self.assertEqual(self.data(), before)

    def test_active_lock_also_blocks_connecting_fresh_and_corrupt_folders(self):
        fresh = self.fixture.base / "fresh-locked"
        fresh.mkdir()
        self.db_path.write_bytes(b"broken state")
        for root in (fresh, self.root):
            with self.subTest(root=root), CollectionLock(root):
                lock = root / "_work/collector.lock"
                before = lock.read_bytes()
                with self.assertRaises(maintenance.MaintenanceError) as failure:
                    maintenance.execute({"command": "reconnect", "root": str(root)})
                self.assertEqual(failure.exception.code, "busy")
                self.assertEqual(lock.read_bytes(), before)
        self.assertFalse((fresh / "state").exists())
        self.assertFalse((fresh / "media").exists())
        self.assertEqual(self.db_path.read_bytes(), b"broken state")

    def test_restore_cannot_overwrite_current_database_or_media(self):
        before = self.data()
        with self.assertRaises(maintenance.MaintenanceError): self.run_command("backup", path=str(self.db_path))
        with self.assertRaises(maintenance.MaintenanceError):
            self.run_command("backup", path=str(self.fixture.originals[0]))
        self.assertEqual(before, self.data())

    def test_metadata_restore_hard_kill_rolls_back_and_own_stale_lock_can_be_recovered(self):
        self.make_backup()
        post_draft.execute({**self.draft_request, "caption": "latest before kill", "expectedRevision": 1})
        before = self.data()
        code = """
import json,os,sys
sys.path.insert(0,sys.argv[1])
import library_maintenance as worker
original=worker.metadata_restore
def crash(db,backup,root,available,deleted,check):
    return original(db,backup,root,available,deleted,lambda:os._exit(92))
worker.metadata_restore=crash
worker.execute(json.loads(sys.argv[2]))
"""
        process = subprocess.run([sys.executable, "-I", "-B", "-c", code,
            str(Path(maintenance.__file__).parent), json.dumps(self.request("restore", path=str(self.backup)))],
            capture_output=True, timeout=20)
        self.assertEqual(process.returncode, 92, process.stderr)
        self.assertEqual(self.data(), before)
        self.assertTrue((self.root / "_work/collector.lock").exists())
        restored = self.run_command("restore", path=str(self.backup))
        self.assertEqual(restored["restore_mode"], "metadata")
        self.assertFalse((self.root / "_work/collector.lock").exists())

    def test_automatic_online_backup_is_itself_restorable(self):
        self.make_backup()
        post_draft.execute({**self.draft_request, "caption": "latest", "expectedRevision": 1})
        first = self.run_command("restore", path=str(self.backup))
        self.run_command("restore", path=first["automatic_backup_path"])
        self.assertEqual(self.data()["post_drafts"][0][2], "latest")

    def test_no_network_called_by_maintenance(self):
        with patch("socket.create_connection", side_effect=AssertionError("No network")):
            self.make_backup()
            self.run_command("restore", path=str(self.backup))
            self.run_command("reconnect")


if __name__ == "__main__": unittest.main()
