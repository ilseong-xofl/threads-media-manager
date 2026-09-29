"""Offline first-image pHash, bounded comparison, and deletion protection."""
from contextlib import closing
import hashlib
import io
import json
from pathlib import Path
import random
import sqlite3
import sys
import unittest
from unittest.mock import patch

from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "local-runtime"))
import duplicate_posts
import perceptual_hash
import test_duplicate_posts as duplicate_fixtures
from test_download_excel import make_book
from threads_source import excel_input


def picture(seed=1, *, quality=95, size=(192, 256)):
    image = Image.new("RGB", (192, 256), (21, 37, 59))
    draw = ImageDraw.Draw(image)
    rng = random.Random(seed)
    for _ in range(30):
        x, y = rng.randrange(160), rng.randrange(220)
        draw.ellipse((x, y, x+rng.randrange(10, 33), y+rng.randrange(10, 37)),
                     fill=tuple(rng.randrange(256) for _ in range(3)))
    image = image.resize(size, Image.Resampling.LANCZOS)
    output = io.BytesIO()
    image.save(output, "JPEG", quality=quality)
    return output.getvalue()


class FingerprintTests(unittest.TestCase):
    def test_recompression_and_resize_have_same_hash_but_different_sha256(self):
        original = picture()
        for variant in (picture(quality=80), picture(size=(384, 512))):
            self.assertNotEqual(hashlib.sha256(original).digest(), hashlib.sha256(variant).digest())
            self.assertEqual(perceptual_hash.fingerprint(original), perceptual_hash.fingerprint(variant))

    def test_different_images_are_not_equal(self):
        self.assertNotEqual(perceptual_hash.fingerprint(picture(1)), perceptual_hash.fingerprint(picture(2)))

    def test_invalid_uniform_and_animated_images_are_not_perceptual_candidates(self):
        self.assertIsNone(perceptual_hash.fingerprint(b"not an image"))
        for color in ("white", "black", "red"):
            output = io.BytesIO()
            Image.new("RGB", (32, 32), color).save(output, "PNG")
            self.assertIsNone(perceptual_hash.fingerprint(output.getvalue()))
        output = io.BytesIO()
        first = Image.open(io.BytesIO(picture()))
        second = Image.open(io.BytesIO(picture(2)))
        first.save(output, "GIF", save_all=True, append_images=[second], duration=100)
        self.assertIsNone(perceptual_hash.fingerprint(output.getvalue()))


class PerceptualDedupTests(unittest.TestCase):
    def setUp(self):
        self.fx = duplicate_fixtures.DuplicatePostsTests()
        self.fx.setUp()
        self.addCleanup(self.fx.doCleanups)
        self.batch = self.fx.batch

    def prepare(self, accounts):
        self.batch.fixture(accounts)
        for index, post in enumerate(self.batch.data["게시글"]):
            post["수집일(KST)"] = f"2026-09-21T12:{index:02}:00+09:00"
            post["최근확인시각(KST)"] = post["수집일(KST)"]
        make_book(self.batch.book, self.batch.data)

    def raw_download(self, contents):
        return self.batch.run_batch(transfer=self.fx.transfer(contents))

    def test_cross_account_first_image_removes_whole_new_post(self):
        self.prepare([("alpha", [2]), ("beta", [2])])
        result = self.fx.run_download({"alpha_000-1": picture(), "alpha_000-2": picture(2),
                                       "beta_000-1": picture(quality=80), "beta_000-2": picture(3)})
        self.assertIsNone(result["problem"])
        self.assertEqual((result["downloadedPosts"], result["duplicatePostsRemoved"]), (2, 1))
        deleted, jobs = self.fx.remaining()
        self.assertEqual(deleted, [("beta", "beta_000")])
        self.assertTrue(all(self.batch.root.joinpath(path).exists() == (post == "alpha_000") for post, path in jobs))
        book = excel_input._read_tables(self.batch.book, {"게시글": ("계정명", "게시글ID", "삭제여부")})
        self.assertEqual([p["게시글ID"] for p in book["게시글"] if p.get("삭제여부") == "Y"], ["beta_000"])
        self.assertEqual(len(self.batch.requests), 4)

    def test_second_images_are_not_compared(self):
        self.prepare([("alpha", [2, 2])])
        result = self.fx.run_download({"alpha_000-1": picture(2), "alpha_000-2": picture(),
                                       "alpha_001-1": picture(3), "alpha_001-2": picture(quality=80)})
        self.assertIsNone(result["problem"])
        self.assertEqual(result["duplicatePostsRemoved"], 0)

    def test_new_first_image_does_not_match_an_existing_second_image(self):
        self.prepare([("alpha", [2, 1])])
        result = self.fx.run_download({"alpha_000-1": picture(2), "alpha_000-2": picture(),
                                       "alpha_001-1": picture(quality=80)})
        self.assertIsNone(result["problem"])
        self.assertEqual(result["duplicatePostsRemoved"], 0)

    def test_first_image_after_a_video_is_compared(self):
        self.prepare([("alpha", [2, 2])])
        for post in self.batch.data["게시글"]:
            post["이미지 수"], post["영상 수"] = 1, 1
        for media in self.batch.data["미디어"]:
            if media["순서"] == 1:
                media["종류"] = "video"
                media["다운로드URL"] = media["다운로드URL"].replace(".jpg?", ".mp4?")
        make_book(self.batch.book, self.batch.data)
        result = self.fx.run_download({"alpha_000-1": b"video A", "alpha_000-2": picture(),
                                       "alpha_001-1": b"video B", "alpha_001-2": picture(quality=80)})
        self.assertIsNone(result["problem"])
        self.assertEqual(result["duplicatePostsRemoved"], 1)

    def test_sha_match_does_not_invoke_phash(self):
        self.prepare([("alpha", [1, 1])])
        with patch.object(perceptual_hash, "ImageHashes", side_effect=AssertionError("pHash must not run")):
            result = self.fx.run_download({"alpha_000-1": picture(), "alpha_001-1": picture()})
        self.assertEqual(result["duplicatePostsRemoved"], 1)

    def test_video_only_posts_do_not_invoke_phash(self):
        self.fx.source([1, 1], video=True)
        with patch.object(perceptual_hash, "ImageHashes", side_effect=AssertionError("pHash must not run")):
            result = self.fx.run_download({"alpha_000-1": b"video A", "alpha_001-1": b"video B"})
        self.assertEqual(result["duplicatePostsRemoved"], 0)

    def older_than_window(self, exact):
        self.prepare([("alpha", [1]*52)])
        contents = {f"alpha_{i:03}-1": picture(2) for i in range(52)}
        contents["alpha_000-1"] = picture()
        contents["alpha_051-1"] = picture(quality=95 if exact else 80)
        self.raw_download(contents)
        return duplicate_posts.remove_new_duplicates(self.batch.root, [("alpha", "alpha_051")])

    def test_phash_is_limited_to_50_recent_first_images(self):
        self.assertEqual(self.older_than_window(False), 0)
        self.assertEqual(self.fx.remaining()[0], [])

    def test_sha_still_matches_beyond_50_images(self):
        self.assertEqual(self.older_than_window(True), 1)
        self.assertEqual(self.fx.remaining()[0], [("alpha", "alpha_051")])

    def test_cache_cannot_authorize_a_false_match(self):
        self.prepare([("alpha", [1, 1])])
        contents = {"alpha_000-1": picture(), "alpha_001-1": picture(2)}
        self.raw_download(contents)
        with closing(sqlite3.connect(self.batch.root / "state/state.db")) as db, db:
            forged = {hashlib.sha256(raw).hexdigest(): "a"*16 for raw in contents.values()}
            db.execute("INSERT INTO meta VALUES(?,?)", (perceptual_hash.CACHE_KEY, json.dumps(forged)))
        with self.assertRaises(duplicate_posts.deletion.DeleteError) as raised:
            duplicate_posts.remove_new_duplicates(self.batch.root, [("alpha", "alpha_001")])
        self.assertEqual(raised.exception.code, "deletion_changed")
        self.assertEqual(self.fx.remaining()[0], [])
        self.assertTrue(all(self.batch.root.joinpath(path).exists() for _, path in self.fx.remaining()[1]))

    def test_changed_cached_keeper_is_not_deleted(self):
        self.prepare([("alpha", [1, 1])])
        contents = {"alpha_000-1": picture(), "alpha_001-1": picture(quality=80)}
        self.raw_download(contents)
        with closing(sqlite3.connect(self.batch.root / "state/state.db")) as db, db:
            cached = {hashlib.sha256(raw).hexdigest(): perceptual_hash.fingerprint(raw) for raw in contents.values()}
            db.execute("INSERT INTO meta VALUES(?,?)", (perceptual_hash.CACHE_KEY, json.dumps(cached)))
            old = db.execute("SELECT final_rel FROM jobs JOIN media USING(media_id) WHERE post_id='alpha_000'").fetchone()[0]
        self.batch.root.joinpath(old).write_bytes(picture(3))
        with self.assertRaises(duplicate_posts.deletion.DeleteError) as raised:
            duplicate_posts.remove_new_duplicates(self.batch.root, [("alpha", "alpha_001")])
        self.assertEqual(raised.exception.code, "deletion_changed")
        self.assertEqual(self.fx.remaining()[0], [])

    def test_protected_new_post_is_not_removed_by_phash(self):
        self.prepare([("alpha", [1, 1])])
        raw = self.raw_download({"alpha_000-1": picture(), "alpha_001-1": picture(quality=80)})
        with closing(sqlite3.connect(self.batch.root / "state/state.db")) as db, db:
            db.execute("CREATE TABLE post_comments(account TEXT,post_id TEXT)")
            db.execute("INSERT INTO post_comments VALUES('alpha','alpha_001')")
        import download_ui
        result = download_ui.finish_batch(self.batch.root, raw, lambda: False, self.fx.events.append)
        self.assertEqual(result["problem"]["code"], "duplicate_protected")
        self.assertEqual(result["duplicatePostsRemoved"], 0)
        self.assertEqual(self.fx.remaining()[0], [])

    def test_cached_fingerprints_are_reused_and_backup_schema_accepts_cache(self):
        self.prepare([("alpha", [1, 1])])
        self.raw_download({"alpha_000-1": picture(), "alpha_001-1": picture(2)})
        key = [("alpha", "alpha_001")]
        self.assertEqual(duplicate_posts.remove_new_duplicates(self.batch.root, key), 0)
        with patch.object(perceptual_hash, "fingerprint", side_effect=AssertionError("cache should be reused")):
            self.assertEqual(duplicate_posts.remove_new_duplicates(self.batch.root, key), 0)
        import library_maintenance
        with closing(sqlite3.connect(self.batch.root / "state/state.db")) as db:
            meta = library_maintenance.validate_db(db)
        self.assertEqual(len(meta[perceptual_hash.CACHE_KEY]), 2)


if __name__ == "__main__": unittest.main()
