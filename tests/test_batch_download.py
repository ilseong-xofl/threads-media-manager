"""Finite batch integration uses synthetic Excel, virtual time, and no network."""
import copy
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "local-runtime"))
import download_ui
from threads_runner import batch, runner, transport
from threads_runner.state import State, StateError, POLICY
from test_download_excel import samples, make_book


class Clock:
    def __init__(self): self.now = 2_000_000_000.0
    def __call__(self): return self.now
    def sleep(self, seconds): self.now += seconds


class BatchDownloadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.book = self.root / "results/2026/09/threads-2026-09-21.xlsx"
        self.clock = Clock()
        self.requests, self.events, self.completions = [], [], []
        self.data = None

    def tearDown(self): self.temp.cleanup()

    def fixture(self, accounts):
        data = {"게시글": [], "미디어": [], "실행기록": []}
        for account, sizes in accounts:
            sample = samples(account=account)
            run = {**sample["실행기록"][0], "실행ID": f"Run_{account}", "특이사항": ""}
            data["실행기록"].append(run)
            for index, count in enumerate(sizes):
                post_id = f"{account}_{index:03}"
                post = {**sample["게시글"][0], "게시글ID": post_id,
                    "원문URL": f"https://www.threads.com/@{account}/post/{post_id}", "등록일(KST)": f"2026-09-20T{index//60:02}:{index%60:02}:00+09:00",
                    "이미지 수": count, "영상 수": 0, "확인실행ID": run["실행ID"]}
                data["게시글"].append(post)
                for ordinal in range(1, count+1):
                    data["미디어"].append({**sample["미디어"][0], "게시글ID": post_id, "순서": ordinal,
                        "확인실행ID": run["실행ID"],
                        "다운로드URL": f"https://scontent-test.cdninstagram.com/{post_id}-{ordinal}.jpg?sig=PRIVATE_TEST"})
        self.data = data
        make_book(self.book, data)

    def fake(self, url, dest, kind, *, before_request, progress, cancel, **kwargs):
        before_request(url, 0)
        self.requests.append({"url": url, "time": self.clock(), "kind": kind, **kwargs})
        self.clock.sleep(2)
        raw = (f"synthetic {len(self.requests)}").encode()
        dest.write_bytes(raw)
        progress("downloading", len(raw), len(raw))
        progress("validating", len(raw), len(raw))
        self.completions.append(self.clock())
        return {"size": len(raw), "sha256": hashlib.sha256(raw).hexdigest(),
            "extension": "jpg" if kind == "image" else "mp4", "content_type": "image/jpeg" if kind == "image" else "video/mp4"}

    def run_batch(self, **kwargs):
        with patch.object(transport, "dependencies"), patch("socket.getaddrinfo", side_effect=AssertionError("Network prohibited")), \
                patch.object(runner.secrets, "randbelow", return_value=0):
            return batch.run(self.root, kwargs.pop("cancel", lambda: False), transfer=kwargs.pop("transfer", self.fake),
                output=kwargs.pop("output", self.events.append), clock=self.clock, sleep=self.clock.sleep,
                monotonic=self.clock, **kwargs)

    def meta(self, key=batch.META):
        with sqlite3.connect(self.root / "state/state.db") as db:
            row = db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
            return json.loads(row[0]) if row else None

    def hashes(self):
        return {str(path.relative_to(self.root)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in self.root.rglob("*") if path.is_file()}

    def test_account_oldest_post_attachment_order_and_final_durable_wait(self):
        self.fixture([("zeta", [1]), ("alpha", [2, 1])])
        self.data["게시글"].reverse()
        self.data["미디어"].reverse()
        make_book(self.book, self.data)
        original = self.book.read_bytes()
        result = self.run_batch()
        self.assertIsNone(result["problem"])
        self.assertEqual(result["batch"], {"totalPosts": 3, "completedPosts": 3, "totalFiles": 4,
            "completedFiles": 4, "totalRounds": 2, "currentRound": 2, "deferredPosts": 0, "skippedPosts": 0})
        self.assertEqual([request["url"].split("/")[-1].split("?")[0] for request in self.requests],
            ["alpha_000-1.jpg", "alpha_000-2.jpg", "alpha_001-1.jpg", "zeta_000-1.jpg"])
        self.assertEqual([round(self.requests[i]["time"]-self.completions[i-1], 4) for i in range(1, 4)], [3, 3, 60])
        self.assertEqual(result["nextAllowedAt"], self.completions[-1] + 60)
        self.assertEqual(self.meta()["boundary"]["accountWaitSeconds"], 10)
        self.assertEqual(self.meta()["boundary"]["roundWaitSeconds"], 60)
        self.assertEqual(self.meta("next_allowed"), result["nextAllowedAt"])
        self.assertEqual(self.book.read_bytes(), original)
        self.assertFalse((self.root / "_work/collector.lock").exists())
        self.assertNotIn("PRIVATE_TEST", json.dumps(self.meta()))

    def test_whole_post_rounds_44_then_last_four_without_splitting(self):
        self.fixture([("alpha", [3]*13 + [5, 4])])
        result = self.run_batch()
        plan = self.meta()
        self.assertEqual(result["batch"]["totalRounds"], 2)
        self.assertEqual([sum(target["round"] == number for target in plan["targets"]) for number in (1, 2)], [44, 4])
        self.assertEqual(len(self.requests), 48)
        self.assertEqual(self.requests[44]["time"]-self.completions[43], 60)
        self.assertEqual({target["round"] for target in plan["targets"] if target["postId"] == "alpha_013"}, {1})

    def test_twenty_three_attachment_posts_form_45_and_15_before_next_account(self):
        self.fixture([("alpha", [3]*20), ("beta", [1])])
        result = self.run_batch()
        self.assertEqual(result["batch"]["totalRounds"], 3)
        self.assertEqual([sum(t["round"] == n for t in self.meta()["targets"]) for n in (1, 2, 3)], [45, 15, 1])
        self.assertEqual(self.requests[45]["time"]-self.completions[44], 60)
        self.assertEqual(self.requests[60]["time"]-self.completions[59], 60)

    def test_unready_post_is_wholly_deferred_and_ready_post_runs(self):
        self.fixture([("alpha", [2, 1])])
        self.data["미디어"][1].update({"주소상태": "missing", "다운로드URL": ""})
        make_book(self.book, self.data)
        result = self.run_batch()
        self.assertEqual(result["problem"]["code"], "posts_deferred")
        self.assertEqual(result["batch"]["deferredPosts"], 1)
        self.assertEqual(len(self.requests), 1)
        self.assertIn("alpha_001", self.requests[0]["url"])

    def test_incomplete_carousel_is_deferred_without_attempting_download(self):
        self.fixture([("alpha", [2])])
        self.data["게시글"][0]["첨부 상태"] = "partial"
        make_book(self.book, self.data)
        self.assertEqual(self.run_batch()["problem"]["code"], "posts_deferred")
        self.assertEqual(len(self.requests), 0)

    def test_oversized_post_or_impossible_middle_round_blocks_later_accounts(self):
        for sizes in ([46, 1], [24, 24, 1]):
            with self.subTest(sizes=sizes):
                posts = [{"account": account, "targets": [None]*size} for account, size in
                    [("alpha", size) for size in sizes] + [("beta", 1)]]
                rounds, blocked = batch.whole_post_rounds(posts)
                self.assertEqual(rounds, [])
                self.assertEqual(blocked, posts)

    def test_prior_valid_round_runs_before_range_boundary_stops(self):
        self.fixture([("alpha", [40, 46]), ("beta", [1])])
        result = self.run_batch()
        self.assertEqual(len(self.requests), 40)
        self.assertEqual(result["problem"]["code"], "posts_deferred")
        self.assertEqual(result["batch"]["deferredPosts"], 2)

    def test_first_http_failure_stops_every_account_without_retry(self):
        self.fixture([("alpha", [2]), ("beta", [1])])
        def fail_second(url, dest, kind, **kwargs):
            if len(self.requests) == 1:
                kwargs["before_request"](url, 0)
                self.requests.append({"url": url, "time": self.clock()})
                raise transport.TransferError("rate_limited", "Server wait", status=429, retry_at=self.clock()+300)
            return self.fake(url, dest, kind, **kwargs)
        result = self.run_batch(transfer=fail_second)
        self.assertEqual(result["problem"]["code"], "rate_limited")
        self.assertEqual(result["batch"]["completedFiles"], 1)
        self.assertEqual(len(self.requests), 2)
        self.assertGreater(result["nextAllowedAt"], self.clock())
        before = self.hashes()
        self.assertEqual(self.run_batch()["problem"]["code"], "stopped")
        self.assertEqual(before, self.hashes())
        self.assertEqual(len(self.requests), 2)

    def test_cancel_during_wait_preserves_plan_completed_file_and_deadline(self):
        self.fixture([("alpha", [2])])
        stopped = False
        def observe(event):
            nonlocal stopped
            self.events.append(event)
            if event["phase"] == "waiting": stopped = True
        result = self.run_batch(cancel=lambda: stopped, output=observe)
        self.assertEqual(result["problem"]["code"], "cancelled")
        self.assertEqual(result["batch"]["completedFiles"], 1)
        self.assertEqual(self.meta()["nextIndex"], 1)
        self.assertEqual(self.meta()["status"], "stopped")
        self.assertEqual(self.meta("next_allowed"), self.completions[0]+3)
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(self.run_batch()["problem"]["code"], "stopped")

    def test_explicit_restart_reuses_same_plan_jobs_and_wait(self):
        self.fixture([("alpha", [1, 1])])
        with patch.object(transport, "dependencies"), State(self.root, clock=self.clock) as state:
            plan = batch._persist_plan(state)
            state.wait_until(self.clock()+42)
        saved = copy.deepcopy(plan)
        initial = self.clock()
        result = self.run_batch()
        self.assertIsNone(result["problem"])
        self.assertGreaterEqual(self.requests[0]["time"], initial+42)
        self.assertEqual(self.meta()["id"], saved["id"])
        self.assertEqual([t["jobId"] for t in self.meta()["targets"]], [t["jobId"] for t in saved["targets"]])
        self.assertEqual(len(self.requests), 2)

    def test_restart_after_complete_file_keeps_uuid_and_does_not_redownload(self):
        self.fixture([("alpha", [2])])
        with patch.object(transport, "dependencies"), patch.object(runner.secrets, "randbelow", return_value=0), State(self.root, clock=self.clock) as state:
            plan = batch._persist_plan(state)
            runner.download_one(self.root, plan["targets"][0]["jobId"], state=state,
                download=lambda *args, **kwargs: self.fake(*args, **kwargs, progress=lambda *event: None))
            deadline = state.meta("next_allowed")
        old_media = {str(path): path.read_bytes() for path in (self.root / "media/files").rglob("*.jpg")}
        self.assertEqual(self.meta()["nextIndex"], 1)
        result = self.run_batch()
        self.assertEqual(result["batch"]["completedFiles"], 2)
        self.assertEqual(len(self.requests), 2)
        self.assertGreaterEqual(self.requests[1]["time"], deadline)
        self.assertEqual(self.meta()["id"], plan["id"])
        self.assertEqual({path: Path(path).read_bytes() for path in old_media}, old_media)

    def test_saved_attachment_without_current_url_does_not_block_remaining_file(self):
        self.fixture([("alpha", [1])])
        self.run_batch()
        old_path = next((self.root / "media/files").rglob("*.jpg"))
        old_bytes = old_path.read_bytes()
        self.data["게시글"][0]["이미지 수"] = 2
        self.data["미디어"].append({**self.data["미디어"][0], "순서": 2})
        self.data["미디어"][0].update({"다운로드URL": "", "주소상태": "missing"})
        make_book(self.book, self.data)
        result = self.run_batch()
        self.assertIsNone(result["problem"])
        self.assertEqual(result["batch"]["totalFiles"], 1)
        self.assertEqual(self.meta()["targets"][0]["ordinal"], 2)
        self.assertEqual(old_path.read_bytes(), old_bytes)
        self.assertEqual(len(self.requests), 2)

    def test_timeout_is_first_global_error_and_preserves_request_record(self):
        self.fixture([("alpha", [2]), ("beta", [1])])
        def timeout(url, dest, kind, **kwargs):
            kwargs["before_request"](url, 0)
            self.requests.append({"url": url})
            raise transport.TransferError("timeout", "CDN transfer timed out.")
        result = self.run_batch(transfer=timeout)
        self.assertEqual(result["problem"]["code"], "timeout")
        self.assertEqual(result["batch"]["completedFiles"], 0)
        self.assertEqual(len(self.requests), 1)
        with sqlite3.connect(self.root / "state/state.db") as db:
            self.assertEqual(db.execute("SELECT count(*) FROM requests").fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT count(*) FROM jobs WHERE status='planned'").fetchone()[0], 2)

    def test_persisted_plan_rejects_added_source_before_get_and_keeps_identity(self):
        self.fixture([("alpha", [1])])
        with patch.object(transport, "dependencies"), State(self.root, clock=self.clock) as state:
            plan = batch._persist_plan(state)
        self.data["게시글"][0]["캡션"] = "New metadata before resume"
        make_book(self.book, self.data)
        result = self.run_batch()
        self.assertEqual(result["problem"]["code"], "source_changed")
        self.assertEqual(self.requests, [])
        self.assertEqual(self.meta()["id"], plan["id"])
        self.assertEqual(self.meta("stop")["code"], "source_changed")

    def test_recover_staged_last_file_commits_boundary_without_network(self):
        self.fixture([("alpha", [1])])
        with patch.object(runner, "_publish", side_effect=OSError("Simulated shutdown before publish")):
            first = self.run_batch()
        self.assertTrue(first["recoverable"])
        with patch.object(runner, "State", side_effect=lambda root, **kwargs: State(root, clock=self.clock)), \
                patch.object(runner.secrets, "randbelow", return_value=0):
            result = runner.recover(self.root)
        self.assertEqual(len(result["recovered"]), 1)
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(self.meta()["nextIndex"], 1)
        self.assertEqual(self.meta()["status"], "complete")
        self.assertEqual(self.meta("next_allowed"), self.clock()+60)
        self.assertIsNotNone(self.meta("stop"))

    def test_new_workbook_during_wait_is_not_adopted_into_plan(self):
        self.fixture([("alpha", [2])])
        added = False
        def observe(event):
            nonlocal added
            if event["phase"] == "waiting" and not added:
                extra = copy.deepcopy(self.data)
                for post in extra["게시글"]:
                    post["게시글ID"] = "added_post"
                    post["원문URL"] = "https://www.threads.com/@alpha/post/added_post"
                    post["수집일(KST)"] = "2026-09-22T12:00:00+09:00"
                    post["최근확인시각(KST)"] = "2026-09-22T12:00:00+09:00"
                    post["확인실행ID"] = "NextRun"
                for media in extra["미디어"]:
                    media["게시글ID"] = "added_post"
                    media["확인실행ID"] = "NextRun"
                    media["URL확보시각(KST)"] = "2026-09-22T12:00:00+09:00"
                extra["실행기록"][0].update({"실행ID": "NextRun", "수집일자(KST)": "2026-09-22",
                    "시작(KST)": "2026-09-22T12:00:00+09:00", "종료(KST)": "2026-09-22T12:10:00+09:00"})
                make_book(self.book.with_name("threads-2026-09-22.xlsx"), extra)
                added = True
        result = self.run_batch(output=observe)
        self.assertTrue(added)
        self.assertEqual(result["problem"]["code"], "source_changed")
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(result["batch"]["totalFiles"], 2)

    def test_sleep_resume_stops_instead_of_starting_next_file(self):
        self.fixture([("alpha", [2])])
        def suspended(seconds): self.clock.sleep(seconds+120)
        with patch.object(transport, "dependencies"), patch.object(runner.secrets, "randbelow", return_value=0):
            result = batch.run(self.root, lambda: False, transfer=self.fake, clock=self.clock,
                sleep=suspended, monotonic=self.clock)
        self.assertEqual(result["problem"]["code"], "system_resume")
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(result["batch"]["completedFiles"], 1)

    def test_file_changed_during_wait_stops_before_next_request(self):
        self.fixture([("alpha", [2])])
        changed = False
        def observe(event):
            nonlocal changed
            if event["phase"] == "waiting" and not changed:
                next((self.root / "media/files").rglob("*.jpg")).write_bytes(b"external modification")
                changed = True
        result = self.run_batch(output=observe)
        self.assertEqual(result["problem"]["code"], "completed_file_changed")
        self.assertEqual(len(self.requests), 1)

    def test_source_change_and_new_posts_during_transfer_stop_before_next_get(self):
        self.fixture([("alpha", [2])])
        def changed(url, dest, kind, **kwargs):
            result = self.fake(url, dest, kind, **kwargs)
            self.data["게시글"][0]["캡션"] = "Changed after plan"
            make_book(self.book, self.data)
            return result
        result = self.run_batch(transfer=changed)
        self.assertEqual(result["problem"]["code"], "source_changed")
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(result["batch"]["completedFiles"], 0)
        self.assertEqual(self.meta()["nextIndex"], 0)

    def test_completed_collection_is_read_only_noop_and_preserves_last_wait(self):
        self.fixture([("alpha", [1])])
        first = self.run_batch()
        before = self.hashes()
        result = self.run_batch()
        self.assertEqual(result["batch"]["totalFiles"], 0)
        self.assertEqual(result["nextAllowedAt"], first["nextAllowedAt"])
        self.assertEqual(before, self.hashes())
        self.assertEqual(len(self.requests), 1)

    def test_empty_collection_does_not_initialize_state(self):
        result = self.run_batch()
        self.assertIsNone(result["problem"])
        self.assertEqual(result["batch"]["totalPosts"], 0)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_external_lock_and_bad_completed_file_block_without_get(self):
        self.fixture([("alpha", [1])])
        with State(self.root, clock=self.clock):
            with self.assertRaises(Exception): self.run_batch()
        self.assertEqual(self.requests, [])
        self.run_batch()
        next((self.root / "media/files").rglob("*.jpg")).write_bytes(b"tampered")
        result = self.run_batch()
        self.assertEqual(result["problem"]["code"], "local_file_changed")
        self.assertEqual(len(self.requests), 1)

    def test_progress_exposes_only_public_target_and_throttles(self):
        self.fixture([("alpha", [3])])
        times = []
        def observe(event):
            times.append(self.clock())
            self.events.append(event)
        self.run_batch(output=observe)
        self.assertTrue(any(event["phase"] == "waiting" for event in self.events))
        self.assertTrue(all(b-a >= .149 for a, b in zip(times, times[1:])))
        for event in self.events:
            if "target" in event:
                self.assertEqual(set(event["target"]), {"account", "postId", "ordinal", "kind"})
        self.assertNotIn("PRIVATE_TEST", json.dumps(self.events))

    def test_worker_batch_rejects_renderer_supplied_plan(self):
        with self.assertRaises(StateError) as failure:
            download_ui.execute(self.root, {"command": "batch", "plan": {}}, lambda: False)
        self.assertEqual(failure.exception.code, "invalid_request")


if __name__ == "__main__": unittest.main()
