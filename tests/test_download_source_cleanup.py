"""Cleanup only abandons unusable collected sources, never interrupted downloads."""
from contextlib import closing
import copy
import json
import sqlite3
import unittest
from unittest.mock import patch

import test_batch_download as fixtures
from test_download_excel import make_book
import collection_view
import download_ui
from threads_runner import batch, inspection, runner, source_cleanup, transport
from threads_runner.state import POLICY, State, StateError


class DownloadSourceCleanupTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.BatchDownloadTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.root, self.clock = self.fixture.root, self.fixture.clock
        self.fixture.meta = self.meta

    def meta(self, key=batch.META):
        with closing(sqlite3.connect(self.root / "state/state.db")) as db:
            row = db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
            return json.loads(row[0]) if row else None

    def rows(self, table):
        with closing(sqlite3.connect(self.root / "state/state.db")) as db:
            db.row_factory = sqlite3.Row
            if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone():
                return []
            return [dict(row) for row in db.execute("SELECT * FROM " + table)]

    def media_files(self):
        return {path.relative_to(self.root).as_posix(): path.read_bytes()
                for path in (self.root / "media").rglob("*") if path.is_file()}

    def clean(self):
        with patch("socket.getaddrinfo", side_effect=AssertionError("Network prohibited")), \
                patch.object(transport, "download", side_effect=AssertionError("Cleanup must not download")):
            return source_cleanup.clean(self.root, clock=self.clock)

    def interrupted(self, code="timeout", *, status=None, retry_delay=None):
        f = self.fixture
        f.fixture([("alpha", [1, 2, 1])])
        def transfer(url, dest, kind, **kwargs):
            if len(f.requests) != 2:
                return f.fake(url, dest, kind, **kwargs)
            kwargs["before_request"](url, 0)
            f.requests.append({"url": url, "time": self.clock()})
            dest.write_bytes(b"preserve interrupted attachment bytes")
            retry_at = self.clock() + retry_delay if retry_delay else None
            raise transport.TransferError(code, "Synthetic interrupted transfer", status=status, retry_at=retry_at)
        result = f.run_batch(transfer=transfer)
        self.assertEqual(result["problem"]["code"], code)
        self.assertEqual(len(f.requests), 3)
        self.assertEqual(result["batch"]["completedPosts"], 1)
        return result

    def test_valid_interrupted_batch_is_untouched_then_explicitly_resumes(self):
        self.interrupted()
        legacy = [{"account": "alpha", "postId": "alpha_002", "reason": "source_not_ready",
                   "excludedAt": self.clock() - 600}]
        with State(self.root, clock=self.clock) as state:
            with state.db:
                state.set_meta("download_exclusions", legacy)
        before = self.fixture.hashes()
        jobs, requests, plan, stop = self.rows("jobs"), self.rows("requests"), self.meta(), self.meta("stop")
        wait = self.meta("next_allowed")
        complete = [row for row in jobs if row["status"] == "complete"]
        failed = next(row for row in jobs if row["status"] == "failed")
        partial = self.root / failed["part_rel"]
        partial_bytes = partial.read_bytes()
        complete_bytes = {row["final_rel"]: (self.root / row["final_rel"]).read_bytes() for row in complete}

        result = self.clean()

        self.assertEqual(result["cleanedPosts"], 0)
        self.assertEqual(self.fixture.hashes(), before)
        self.assertEqual(self.meta(), plan)
        self.assertEqual(self.meta("stop"), stop)
        self.assertEqual(self.meta("next_allowed"), wait)
        self.assertEqual(self.meta("download_exclusions"), legacy)
        self.assertEqual(self.rows("jobs"), jobs)
        self.assertEqual(self.rows("requests"), requests)
        self.assertEqual(self.rows("post_deletions"), [])
        self.assertEqual(len(self.fixture.requests), 3)

        resumed = self.fixture.run_batch(resume_requested=True)

        self.assertIsNone(resumed["problem"])
        self.assertEqual(resumed["batch"]["totalPosts"], 3)
        self.assertEqual(resumed["batch"]["completedPosts"], 3)
        self.assertEqual(resumed["batch"]["completedFiles"], 4)
        self.assertEqual(len(self.fixture.requests), 5)
        self.assertEqual(self.rows("requests")[:len(requests)], requests)
        self.assertEqual(partial.read_bytes(), partial_bytes)
        self.assertIn(failed, self.rows("jobs"))
        for row in complete:
            self.assertIn(row, self.rows("jobs"))
            self.assertEqual((self.root / row["final_rel"]).read_bytes(), complete_bytes[row["final_rel"]])
        self.assertEqual(self.rows("post_deletions"), [])

    def test_retired_failure_does_not_block_cleanup_of_new_unrelated_invalid_post(self):
        self.interrupted()
        failed = next(row for row in self.rows("jobs") if row["status"] == "failed")
        partial = self.root / failed["part_rel"]
        partial_bytes = partial.read_bytes()
        resumed = self.fixture.run_batch(resume_requested=True)
        self.assertIsNone(resumed["problem"])
        self.assertEqual(resumed["batch"]["completedPosts"], 3)
        attempts = self.rows("job_attempts")
        self.assertTrue(any(row["previous_job_id"] == failed["job_id"] for row in attempts))
        data = copy.deepcopy(self.fixture.data)
        post = copy.deepcopy(data["게시글"][0])
        post.update({"게시글ID": "alpha_003", "원문URL": "https://www.threads.com/@alpha/post/alpha_003",
                     "등록일(KST)": "2026-09-20T00:03:00+09:00", "이미지 수": 1})
        media = copy.deepcopy(data["미디어"][0])
        media.update({"게시글ID": "alpha_003", "순서": 1, "주소상태": "missing", "다운로드URL": ""})
        data["게시글"].append(post)
        data["미디어"].append(media)
        make_book(self.fixture.book, data)
        source, files, jobs, requests = self.fixture.book.read_bytes(), self.media_files(), self.rows("jobs"), self.rows("requests")
        result = self.clean()
        self.assertEqual(result["cleanedPosts"], 1)
        self.assertEqual({(row["account"], row["post_id"]) for row in self.rows("post_deletions")},
                         {("alpha", "alpha_003")})
        self.assertEqual(self.fixture.book.read_bytes(), source)
        self.assertEqual(self.media_files(), files)
        self.assertEqual(partial.read_bytes(), partial_bytes)
        self.assertEqual(self.rows("jobs"), jobs)
        self.assertEqual(self.rows("requests"), requests)
        self.assertEqual(self.rows("job_attempts"), attempts)
        self.assertEqual(len(self.fixture.requests), 5)

    def test_rate_limited_valid_batch_keeps_retry_deadline_and_failed_partial(self):
        self.interrupted("rate_limited", status=429, retry_delay=300)
        before, deadline = self.fixture.hashes(), self.meta("next_allowed")
        requests, files = self.rows("requests"), self.media_files()
        result = self.clean()
        self.assertEqual(result["cleanedPosts"], 0)
        self.assertEqual(self.fixture.hashes(), before)
        self.assertEqual(self.meta("next_allowed"), deadline)
        self.assertEqual(self.rows("requests"), requests)
        self.assertEqual(self.media_files(), files)
        self.assertEqual(self.rows("post_deletions"), [])
        resumed = self.fixture.run_batch(resume_requested=True)
        self.assertIsNone(resumed["problem"])
        self.assertGreaterEqual(self.fixture.requests[3]["time"], deadline)
        self.assertEqual(self.rows("requests")[:len(requests)], requests)
        self.assertEqual(requests[-1]["http_status"], 429)

    def test_invalid_excluded_source_is_cleaned_but_completed_ready_post_is_kept(self):
        self.fixture.fixture([("alpha", [2, 1])])
        self.fixture.data["미디어"][1].update({"주소상태": "missing", "다운로드URL": ""})
        make_book(self.fixture.book, self.fixture.data)
        downloaded = self.fixture.run_batch()
        self.assertEqual(downloaded["problem"]["code"], "posts_deferred")
        self.assertEqual(downloaded["batch"]["deferredPosts"], 1)
        legacy = [{"account": "alpha", "postId": "alpha_000", "reason": "attachment_not_ready",
                   "excludedAt": self.clock()}]
        with State(self.root, clock=self.clock) as state:
            with state.db:
                state.set_meta("download_exclusions", legacy)
        source, files = self.fixture.book.read_bytes(), self.media_files()
        jobs, media, requests = self.rows("jobs"), self.rows("media"), self.rows("requests")
        wait = self.meta("next_allowed")

        result = self.clean()

        self.assertEqual(result["cleanedPosts"], 1)
        self.assertEqual({(row["account"], row["post_id"]) for row in self.rows("post_deletions")},
                         {("alpha", "alpha_000")})
        self.assertEqual(self.fixture.book.read_bytes(), source)
        self.assertEqual(self.media_files(), files)
        self.assertEqual(self.rows("jobs"), jobs)
        self.assertEqual(self.rows("media"), media)
        self.assertEqual(self.rows("requests"), requests)
        self.assertEqual(self.meta("next_allowed"), wait)
        self.assertEqual(self.meta("download_exclusions"), legacy)
        self.assertEqual(len(self.fixture.requests), 1)
        posts = collection_view.read_snapshot(self.root)["snapshot"]["posts"]
        self.assertEqual([post["postId"] for post in posts], ["alpha_001"])
        before = self.fixture.hashes()
        self.assertEqual(self.clean()["cleanedPosts"], 0)
        self.assertEqual(self.fixture.hashes(), before)

    def test_complete_post_in_partial_run_is_preserved_and_downloads(self):
        self.fixture.fixture([("alpha", [2])])
        self.fixture.data["실행기록"][0].update({"결과": "partial", "누락상태": "unknown"})
        make_book(self.fixture.book, self.fixture.data)
        with State(self.root, clock=self.clock):
            pass
        before = self.fixture.hashes()
        result = self.clean()
        self.assertEqual(result["cleanedPosts"], 0)
        self.assertEqual(self.fixture.hashes(), before)
        self.assertEqual(self.rows("post_deletions"), [])
        with patch.object(transport, "dependencies"):
            preview = inspection.preview_one(self.root, "alpha", clock=self.clock)
        self.assertIsNone(preview["problem"])
        self.assertEqual(preview["target"]["postId"], "alpha_000")
        stopped = [False]
        first = self.fixture.run_batch(cancel=lambda: stopped[0],
            output=lambda event: stopped.__setitem__(0, event["phase"] == "waiting"))
        self.assertEqual(first["batch"]["completedFiles"], 1)
        result = self.fixture.run_batch(resume_requested=True)
        self.assertIsNone(result["problem"])
        self.assertEqual(result["batch"]["completedPosts"], 1)
        self.assertEqual(result["batch"]["completedFiles"], 2)
        self.assertEqual(len(self.fixture.requests), 2)

    def test_complete_post_in_unlocked_running_run_is_preserved_and_downloads(self):
        self.fixture.fixture([("alpha", [1])])
        self.fixture.data["실행기록"][0].update({"결과": "running", "종료(KST)": "", "누락상태": "unknown"})
        make_book(self.fixture.book, self.fixture.data)
        with State(self.root, clock=self.clock):
            pass
        before = self.fixture.hashes()
        self.assertEqual(self.clean()["cleanedPosts"], 0)
        self.assertEqual(self.fixture.hashes(), before)
        self.assertEqual(self.rows("post_deletions"), [])
        result = self.fixture.run_batch()
        self.assertIsNone(result["problem"])
        self.assertEqual(result["batch"]["completedFiles"], 1)

    def test_partial_run_cleans_only_incomplete_post_and_keeps_complete_neighbor(self):
        self.fixture.fixture([("alpha", [2, 1])])
        self.fixture.data["실행기록"][0].update({"결과": "partial", "누락상태": "unknown"})
        self.fixture.data["게시글"][0]["첨부 상태"] = "partial"
        self.fixture.data["미디어"][1].update({"주소상태": "missing", "다운로드URL": ""})
        make_book(self.fixture.book, self.fixture.data)
        with State(self.root, clock=self.clock):
            pass
        source, files = self.fixture.book.read_bytes(), self.media_files()
        result = self.clean()
        self.assertEqual(result["cleanedPosts"], 1)
        self.assertEqual({(row["account"], row["post_id"]) for row in self.rows("post_deletions")},
                         {("alpha", "alpha_000")})
        self.assertEqual(self.fixture.book.read_bytes(), source)
        self.assertEqual(self.media_files(), files)
        result = self.fixture.run_batch()
        self.assertIsNone(result["problem"])
        self.assertEqual(result["batch"]["completedPosts"], 1)
        self.assertEqual(len(self.fixture.requests), 1)
        self.assertIn("alpha_001-1.jpg", self.fixture.requests[0]["url"])

    def test_logically_invalid_media_candidate_is_local_to_its_post(self):
        self.fixture.fixture([("alpha", [2, 1])])
        self.fixture.data["미디어"][1].update({"주소상태": "http_candidate", "다운로드URL": "not a URL"})
        make_book(self.fixture.book, self.fixture.data)
        with State(self.root, clock=self.clock):
            pass
        source, files = self.fixture.book.read_bytes(), self.media_files()
        result = self.clean()
        self.assertEqual(result["cleanedPosts"], 1)
        self.assertEqual({(row["account"], row["post_id"]) for row in self.rows("post_deletions")},
                         {("alpha", "alpha_000")})
        self.assertEqual(self.fixture.book.read_bytes(), source)
        self.assertEqual(self.media_files(), files)
        result = self.fixture.run_batch()
        self.assertIsNone(result["problem"])
        self.assertEqual(result["batch"]["completedPosts"], 1)
        self.assertEqual(len(self.fixture.requests), 1)
        self.assertIn("alpha_001-1.jpg", self.fixture.requests[0]["url"])

    def test_workbook_wide_and_unknown_run_errors_never_authorize_cleanup(self):
        self.fixture.fixture([("alpha", [1, 1])])
        with State(self.root, clock=self.clock):
            pass
        for kind in ("missing_header", "unknown_run_state"):
            with self.subTest(kind=kind):
                data = copy.deepcopy(self.fixture.data)
                if kind == "missing_header":
                    make_book(self.fixture.book, data, missing_header="계정명")
                else:
                    data["실행기록"][0]["결과"] = "unknown_future_run_state"
                    make_book(self.fixture.book, data)
                before = self.fixture.hashes()
                with self.assertRaises(StateError) as failure:
                    self.clean()
                self.assertEqual(failure.exception.code, "invalid_source")
                self.assertEqual(self.fixture.hashes(), before)
                self.assertEqual(self.rows("post_deletions"), [])
                self.assertEqual(self.rows("jobs"), [])
                self.assertEqual(self.rows("requests"), [])

    def test_batch_command_cleans_invalid_candidate_then_downloads_only_ready_post(self):
        self.fixture.fixture([("alpha", [2, 1])])
        self.fixture.data["미디어"][1].update({"주소상태": "http_candidate", "다운로드URL": "not a URL"})
        make_book(self.fixture.book, self.fixture.data)
        source = self.fixture.book.read_bytes()
        original_run, original_clean = batch.run, source_cleanup.clean
        def virtual_batch(root, cancel, **kwargs):
            return original_run(root, cancel, clock=self.clock, sleep=self.clock.sleep,
                                monotonic=self.clock, **kwargs)
        with patch.object(batch, "run", side_effect=virtual_batch),                 patch.object(source_cleanup, "clean", side_effect=lambda root: original_clean(root, clock=self.clock)),                 patch.object(transport, "dependencies"),                 patch.object(runner.secrets, "randbelow", return_value=0),                 patch("socket.getaddrinfo", side_effect=AssertionError("Network prohibited")):
            result = download_ui.execute(self.root, {"command": "batch"}, lambda: False,
                transfer=self.fixture.fake, output=self.fixture.events.append)
        self.assertIsNone(result["problem"])
        self.assertEqual(result["cleanedPosts"], 1)
        self.assertEqual(result["batch"]["completedPosts"], 1)
        self.assertEqual(result["batch"]["completedFiles"], 1)
        self.assertEqual(len(self.fixture.requests), 1)
        self.assertIn("alpha_001-1.jpg", self.fixture.requests[0]["url"])
        self.assertEqual(self.fixture.book.read_bytes(), source)

    def test_ready_unsaved_collection_is_never_cleaned(self):
        self.fixture.fixture([("alpha", [2])])
        with State(self.root, clock=self.clock):
            pass
        before = self.fixture.hashes()
        self.assertEqual(self.clean()["cleanedPosts"], 0)
        self.assertEqual(self.fixture.hashes(), before)
        self.assertEqual(self.rows("post_deletions"), [])
        self.assertEqual(len(collection_view.read_snapshot(self.root)["snapshot"]["posts"]), 1)
        downloaded = self.fixture.run_batch()
        self.assertIsNone(downloaded["problem"])
        self.assertEqual(downloaded["batch"]["completedFiles"], 2)

    def test_valid_legacy_exclusion_is_released_with_history_and_skipped_plan_repaired(self):
        self.fixture.fixture([("alpha", [2])])
        legacy = [{"account": "alpha", "postId": "alpha_000", "reason": "source_not_ready",
                   "excludedAt": self.clock() - 600}]
        source = self.fixture.book.read_bytes()
        sources = runner._source(self.root)["sources"]
        plan = {"version": 1, "id": "a" * 32, "policy": POLICY, "sources": sources, "targets": [],
                "totalPosts": 0, "totalRounds": 0, "nextIndex": 0, "deferred": [],
                "skipped": [{"account": "alpha", "postId": "alpha_000", "reason": "source_not_ready"}],
                "status": "complete", "createdAt": self.clock() - 600}
        with State(self.root, clock=self.clock) as state:
            with state.db:
                state.set_meta("download_exclusions", legacy)
                state.set_meta(batch.META, plan)
        result = self.clean()
        self.assertEqual(result["cleanedPosts"], 0)
        self.assertEqual(result["releasedPosts"], 1)
        self.assertEqual(self.meta("download_exclusions") or [], [])
        released = self.meta("source_cleanup_releases")
        self.assertEqual(len(released), 1)
        self.assertEqual(released[0]["account"], "alpha")
        self.assertEqual(released[0]["postId"], "alpha_000")
        self.assertEqual(self.meta()["skipped"], [])
        self.assertEqual({key: value for key, value in self.meta().items() if key != "skipped"},
                         {key: value for key, value in plan.items() if key != "skipped"})
        self.assertEqual(self.fixture.book.read_bytes(), source)
        self.assertEqual(self.rows("post_deletions"), [])
        self.assertEqual(self.rows("jobs"), [])
        self.assertEqual(self.rows("requests"), [])
        self.assertEqual(len(collection_view.read_snapshot(self.root)["snapshot"]["posts"]), 1)
        downloaded = self.fixture.run_batch()
        self.assertIsNone(downloaded["problem"])
        self.assertEqual(downloaded["batch"]["completedFiles"], 2)
        self.assertEqual(len(self.fixture.requests), 2)
        self.assertEqual(self.meta("source_cleanup_releases"), released)

    def test_saved_post_is_preserved_when_later_source_attachment_is_invalid(self):
        self.fixture.fixture([("alpha", [1])])
        self.fixture.run_batch()
        self.fixture.data["미디어"][0].update({"주소상태": "missing", "다운로드URL": ""})
        make_book(self.fixture.book, self.fixture.data)
        before = self.fixture.hashes()
        self.assertEqual(self.clean()["cleanedPosts"], 0)
        self.assertEqual(self.fixture.hashes(), before)
        self.assertEqual(self.rows("post_deletions"), [])
        self.assertEqual(len(self.fixture.requests), 1)


if __name__ == "__main__":
    unittest.main()
