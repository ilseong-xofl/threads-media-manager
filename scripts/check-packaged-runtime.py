"""Offline smoke test of the actual packaged runtime, using disposable data only."""
from contextlib import closing
import io
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile

root = Path(sys.argv[1]).resolve()
assert Path(sys.executable).resolve().is_relative_to(root), "System Python must not be used"
sys.path.insert(0, str(root / "local-runtime"))
import collection_view
import perceptual_hash
from PIL import Image

assert Path(collection_view.__file__).resolve().is_relative_to(root)
assert Path(Image.__file__).resolve().is_relative_to(root)
with tempfile.TemporaryDirectory(prefix="tmm-한글 日本語 ") as directory:
    folder = Path(directory).resolve()
    assert collection_view.read_snapshot(folder)["snapshot"]["posts"] == []
    assert not list(folder.iterdir()), "Reading an empty library must not create data"
    with closing(sqlite3.connect(folder / "test.db")) as db:
        db.execute("CREATE TABLE check_data (value TEXT)")
        db.execute("INSERT INTO check_data VALUES (?)", ("한글 日本語",))
        assert db.execute("SELECT value FROM check_data").fetchone()[0] == "한글 日本語"
    image = Image.new("L", (64, 64))
    image.putdata([(x * 7 + y * 11) % 256 for y in range(64) for x in range(64)])
    raw = io.BytesIO()
    image.save(raw, "PNG")
    assert len(perceptual_hash.fingerprint(raw.getvalue())) == 16
    path = folder / "영상 test.mp4"
    subprocess.run([str(root / "bin/ffmpeg.exe"), "-v", "error", "-f", "lavfi", "-i",
                    "testsrc2=size=32x32:rate=1", "-t", "1", "-c:v", "libx264", str(path)],
                   check=True, capture_output=True, timeout=30)
    result = subprocess.run([str(root / "bin/ffprobe.exe"), "-v", "error", "-show_streams", "-of", "json", str(path)],
                            check=True, capture_output=True, text=True, encoding="utf-8", timeout=30)
    assert json.loads(result.stdout)["streams"][0]["codec_name"] == "h264"
print(json.dumps({"python": sys.version.split()[0], "pillow": Image.__version__,
                  "sqlite": sqlite3.sqlite_version, "phash": "passed", "video": "passed",
                  "unicodePaths": "passed", "externalRequests": 0}))
