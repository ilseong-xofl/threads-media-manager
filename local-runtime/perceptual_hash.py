"""Conservative first-image pHash with a bounded, disposable SQLite cache.

Pillow is already part of the local app. The separable 32x32 DCT needs only
its lowest 8x8 coefficients, so no NumPy/SciPy runtime is required. This runs
entirely on the user's PC without AI, Codex, network calls, or model files.
"""
from contextlib import closing
import hashlib
import io
import json
import math
import re
from statistics import median
import warnings

import delete_media as deletion
from threads_runner.state import safe_path
from threads_source.files import read_stable

RECENT_IMAGES = 50
CACHE_KEY = "first_image_phash_dct32_v1"
CACHE_LIMIT = 256
MAX_IMAGE_BYTES = 64 * 1024 * 1024
HASH_PATTERN = re.compile(r"[0-9a-f]{16}")
_COSINES = tuple(tuple(math.cos(math.pi * k * (2*x + 1) / 64) for x in range(32)) for k in range(8))


def fingerprint(raw):
    """Return 64 bits as hex, or None for unsupported/undecodable images.

Animated images and uniform images do not qualify for automatic perceptual
deletion. Their exact-byte SHA-256 comparison remains available.
"""
    from PIL import Image, ImageOps

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as source:
                if getattr(source, "n_frames", 1) != 1:
                    return None
                small = ImageOps.exif_transpose(source).convert("L").resize((32, 32), Image.Resampling.LANCZOS)
                pixels = small.tobytes()
                if min(pixels) == max(pixels):
                    return None
    except (OSError, ValueError, Image.DecompressionBombError, Image.DecompressionBombWarning):
        return None

    rows = [pixels[start:start+32] for start in range(0, 1024, 32)]
    horizontal = [[math.fsum(value * weight for value, weight in zip(row, weights))
                   for weights in _COSINES] for row in rows]
    low = [math.fsum(horizontal[y][x] * weights[y] for y in range(32))
           for weights in _COSINES for x in range(8)]
    midpoint = median(low)
    value = 0
    for coefficient in low:
        value = (value << 1) | (coefficient > midpoint)
    return f"{value:016x}"


class ImageHashes:
    def __init__(self, root):
        self.root = root
        self.values = {}
        self.dirty = False
        with closing(deletion.open_db(root)) as db:
            row = db.execute("SELECT value FROM meta WHERE key=?", (CACHE_KEY,)).fetchone()
        if row:
            try:
                cached = json.loads(row[0])
                if isinstance(cached, dict) and len(cached) <= CACHE_LIMIT:
                    self.values = {sha: value for sha, value in cached.items()
                                   if deletion.HEX.fullmatch(sha) and
                                   (value is None or isinstance(value, str) and HASH_PATTERN.fullmatch(value))}
            except (ValueError, TypeError):
                pass  # Derived cache corruption never authorizes a deletion.

    def get(self, item, *, fresh=False):
        sha = item["sha256"]
        if not fresh and sha in self.values:
            value = self.values.pop(sha)
            self.values[sha] = value
            return value
        path = safe_path(self.root, item["final_rel"], require_file=True)
        if item["size"] > MAX_IMAGE_BYTES:
            return None
        raw = read_stable(path, max_bytes=MAX_IMAGE_BYTES)
        if len(raw) != item["size"] or hashlib.sha256(raw).hexdigest() != sha:
            raise deletion.DeleteError("deletion_changed", "시각적 중복 비교 파일이 변경되었습니다. 파일을 보존했습니다.")
        value = fingerprint(raw)
        self.values.pop(sha, None)
        self.values[sha] = value
        while len(self.values) > CACHE_LIMIT:
            del self.values[next(iter(self.values))]
        self.dirty = True
        return value

    def verify_match(self, item, existing):
        # Never trust a cached match to delete files: verify both current bytes
        # against their own SHA-256 and calculate both fingerprints again.
        first = self.get(item, fresh=True)
        second = self.get(existing, fresh=True)
        if first is None or first != second:
            raise deletion.DeleteError("deletion_changed", "시각적 중복 판정이 달라져 파일을 보존했습니다.")

    def save(self, lock):
        if not self.dirty:
            return
        lock.assert_owned()
        with closing(deletion.open_db(self.root, "rw")) as db, db:
            db.execute("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                       (CACHE_KEY, json.dumps(self.values, separators=(",", ":"))))
