"""Exact first-media deduplication after synthetic, offline batch downloads."""
from contextlib import closing
import hashlib
from pathlib import Path
import sqlite3
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "local-runtime"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import download_ui
import test_batch_download as batch_fixtures
from test_download_excel import make_book
from threads_source import excel_input


class DuplicatePostsTests(unittest.TestCase):
    def setUp(self):
        self.batch = batch_fixtures.BatchDownloadTests()
        self.batch.setUp()
        self.addCleanup(self.batch.tearDown)
        self.events = []

    def source(self, sizes, *, video=False):
        self.batch.fixture([("alpha", sizes)])
        for index, post in enumerate(self.batch.data["게시글"]):
            post["수집일(KST)"] = f"2026-09-21T12:{index:02}:00+09:00"
            post["최근확인시각(KST)"] = post["수집일(KST)"]
            if video:
                post["이미지 수"], post["영상 수"] = 0, sizes[index]
        if video:
            for media in self.batch.data["미디어"]:
                media["종류"] = "video"
                media["다운로드URL"] = media["다운로드URL"].replace(".jpg?", ".mp4?")
        make_book(self.batch.book, self.batch.data)

    def transfer(self, contents):
        def fake(url, dest, kind, *, before_request, progress, cancel, **kwargs):
            before_request(url, 0)
            marker = url.rsplit("/", 1)[-1].split(".")[0]
            raw = contents[marker]
            self.batch.requests.append(marker)
            self.batch.clock.sleep(2)
            dest.write_bytes(raw)
            progress("downloading", len(raw), len(raw))
            progress("validating", len(raw), len(raw))
            return {"size": len(raw), "sha256": hashlib.sha256(raw).hexdigest(),
                    "extension": "mp4" if kind == "video" else "jpg",
                    "content_type": "video/mp4" if kind == "video" else "image/jpeg"}
        return fake

    def run_download(self, contents):
        raw = self.batch.run_batch(transfer=self.transfer(contents))
        return download_ui.finish_batch(self.batch.root, raw, lambda: False, self.events.append)

    def remaining(self):
        with closing(sqlite3.connect(self.batch.root / "state/state.db")) as db:
            deleted = db.execute("SELECT account,post_id FROM post_deletions").fetchall() if db.execute(
                "SELECT 1 FROM sqlite_master WHERE name='post_deletions'").fetchone() else []
            jobs = db.execute("""SELECT m.post_id,j.final_rel FROM jobs j JOIN media m USING(media_id)
                WHERE j.status='complete' ORDER BY m.post_id,m.ordinal""").fetchall()
        return deleted, jobs

    def test_later_download_with_same_first_image_removes_whole_new_post(self):
        self.source([2, 2])
        second_post = self.batch.data["게시글"].pop()
        second_media = [row for row in self.batch.data["미디어"] if row["게시글ID"] == second_post["게시글ID"]]
        self.batch.data["미디어"] = [row for row in self.batch.data["미디어"] if row not in second_media]
        make_book(self.batch.book, self.batch.data)
        contents = {"alpha_000-1": b"same-first-image", "alpha_000-2": b"older-second-image",
                    "alpha_001-1": b"same-first-image", "alpha_001-2": b"different-second-image"}
        first = self.run_download(contents)
        self.assertEqual((first["downloadedPosts"], first["duplicatePostsRemoved"]), (1, 0))
        self.batch.data["게시글"].append(second_post)
        self.batch.data["미디어"].extend(second_media)
        make_book(self.batch.book, self.batch.data)
        second = self.run_download(contents)
        self.assertIsNone(second["problem"])
        self.assertEqual((second["downloadedPosts"], second["duplicatePostsRemoved"]), (1, 1))
        deleted, jobs = self.remaining()
        self.assertEqual(deleted, [("alpha", "alpha_001")])
        self.assertTrue(all(self.batch.root.joinpath(path).exists() for post, path in jobs if post == "alpha_000"))
        self.assertTrue(all(not self.batch.root.joinpath(path).exists() for post, path in jobs if post == "alpha_001"))
        book = excel_input._read_tables(self.batch.book, {"게시글": ("계정명", "게시글ID", "삭제여부")})
        marked = {row["게시글ID"]: row.get("삭제여부") for row in book["게시글"]}
        self.assertEqual(marked["alpha_001"], "Y")
        self.assertNotEqual(marked["alpha_000"], "Y")
        again = self.run_download(contents)
        self.assertEqual((again["downloadedPosts"], again["duplicatePostsRemoved"]), (0, 0))
        self.assertEqual(len(self.batch.requests), 4)

    def test_other_images_do_not_count(self):
        self.source([2, 2])
        result = self.run_download({"alpha_000-1": b"first-A", "alpha_000-2": b"shared-second",
                                    "alpha_001-1": b"first-B", "alpha_001-2": b"shared-second"})
        self.assertEqual((result["downloadedPosts"], result["duplicatePostsRemoved"]), (2, 0))
        self.assertEqual(self.remaining()[0], [])

    def test_new_first_image_matching_existing_second_is_not_removed(self):
        self.source([2, 2])
        result = self.run_download({"alpha_000-1": b"older-first", "alpha_000-2": b"shared",
                                    "alpha_001-1": b"shared", "alpha_001-2": b"new-second"})
        self.assertEqual((result["downloadedPosts"], result["duplicatePostsRemoved"]), (2, 0))
        self.assertEqual(self.remaining()[0], [])

    def test_already_deleted_post_is_not_a_comparison_target(self):
        self.source([1, 1])
        second_post = self.batch.data["게시글"].pop()
        second_media = self.batch.data["미디어"].pop()
        make_book(self.batch.book, self.batch.data)
        contents = {"alpha_000-1": b"same", "alpha_001-1": b"same"}
        self.run_download(contents)
        with closing(sqlite3.connect(self.batch.root / "state/state.db")) as db, db:
            db.execute("""CREATE TABLE post_deletions(account TEXT,post_id TEXT,deleted_at TEXT,
                PRIMARY KEY(account,post_id))""")
            db.execute("INSERT INTO post_deletions VALUES('alpha','alpha_000','2026-09-21T12:00:00+09:00')")
        self.batch.data["게시글"].append(second_post)
        self.batch.data["미디어"].append(second_media)
        make_book(self.batch.book, self.batch.data)
        result = self.run_download(contents)
        self.assertEqual((result["downloadedPosts"], result["duplicatePostsRemoved"]), (1, 0))
        self.assertEqual(self.remaining()[0], [("alpha", "alpha_000")])

    def test_first_video_uses_exact_same_rule(self):
        self.source([1, 1], video=True)
        result = self.run_download({"alpha_000-1": b"identical-video-bytes", "alpha_001-1": b"identical-video-bytes"})
        self.assertEqual((result["downloadedPosts"], result["duplicatePostsRemoved"]), (2, 1))
        self.assertEqual(self.remaining()[0], [("alpha", "alpha_001")])

    def test_other_videos_do_not_count(self):
        self.source([2, 2], video=True)
        result = self.run_download({"alpha_000-1": b"first-video-A", "alpha_000-2": b"shared-second-video",
                                    "alpha_001-1": b"first-video-B", "alpha_001-2": b"shared-second-video"})
        self.assertEqual((result["downloadedPosts"], result["duplicatePostsRemoved"]), (2, 0))
        self.assertEqual(self.remaining()[0], [])

    def test_changed_keeper_file_preserves_new_post(self):
        self.source([1, 1])
        raw = self.batch.run_batch(transfer=self.transfer({"alpha_000-1": b"same", "alpha_001-1": b"same"}))
        with closing(sqlite3.connect(self.batch.root / "state/state.db")) as db:
            old = db.execute("""SELECT j.final_rel FROM jobs j JOIN media m USING(media_id)
                WHERE m.post_id='alpha_000'""").fetchone()[0]
        self.batch.root.joinpath(old).write_bytes(b"changed")
        result = download_ui.finish_batch(self.batch.root, raw, lambda: False, self.events.append)
        self.assertIsNotNone(result["problem"])
        self.assertEqual(result["duplicatePostsRemoved"], 0)
        self.assertEqual(self.remaining()[0], [])

    def test_existing_user_work_on_new_post_blocks_automatic_deletion(self):
        self.source([1, 1])
        raw = self.batch.run_batch(transfer=self.transfer({"alpha_000-1": b"same", "alpha_001-1": b"same"}))
        with closing(sqlite3.connect(self.batch.root / "state/state.db")) as db, db:
            db.execute("CREATE TABLE post_comments(account TEXT,post_id TEXT)")
            db.execute("INSERT INTO post_comments VALUES('alpha','alpha_001')")
        result = download_ui.finish_batch(self.batch.root, raw, lambda: False, self.events.append)
        self.assertEqual(result["problem"]["code"], "duplicate_protected")
        self.assertEqual(result["duplicatePostsRemoved"], 0)
        self.assertEqual(self.remaining()[0], [])
        self.assertTrue(all(self.batch.root.joinpath(path).exists() for _, path in self.remaining()[1]))


if __name__ == "__main__": unittest.main()
