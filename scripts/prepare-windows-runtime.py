"""Build-only downloads; the installed app never installs Python or packages."""
from pathlib import Path
import hashlib
import json
import shutil
import sys
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def prepare():
    if sys.platform != "win32":
        raise SystemExit("Prepare the Windows runtime on a Windows x64 runner.")
    manifest = json.loads((ROOT / "scripts/windows-runtime.json").read_text(encoding="utf-8"))
    output = ROOT / "build/runtime"
    cache = ROOT / "build/downloads"
    cache.mkdir(parents=True, exist_ok=True)
    # Only this script's generated build directory is replaced.
    if output.exists():
        shutil.rmtree(output)
    (output / "bin").mkdir(parents=True)
    for item in manifest["downloads"]:
        target = cache / item["name"]
        if not target.exists() or hashlib.sha256(target.read_bytes()).hexdigest() != item["sha256"]:
            print("Downloading " + item["name"], flush=True)
            request = urllib.request.Request(item["url"], headers={"User-Agent": "ThreadsMediaManager-build"})
            with urllib.request.urlopen(request, timeout=120) as response, target.open("wb") as file:
                shutil.copyfileobj(response, file)
        if hashlib.sha256(target.read_bytes()).hexdigest() != item["sha256"]:
            raise RuntimeError("Runtime checksum mismatch: " + item["name"])
        if item["name"] in {"python.zip", "pillow.whl"}:
            destination = output / ("python" if item["name"] == "python.zip" else "python/Lib/site-packages")
            with zipfile.ZipFile(target) as archive:
                archive.extractall(destination)
        else:
            shutil.copy2(target, output / "bin" / item["name"])
    # Isolated application-local imports, independent of registry/PYTHONPATH/user packages.
    (output / "python/python313._pth").write_text("python313.zip\n.\nLib/site-packages\n", encoding="utf-8")
    for directory in ("local-runtime", "plugins/threads-collector/scripts"):
        for source in (ROOT / directory).rglob("*.py"):
            destination = output / source.relative_to(ROOT)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
    shutil.copy2(ROOT / "scripts/windows-runtime.json", output / "runtime-manifest.json")
    print("Bundled Python, Pillow, SQLite, ffmpeg, ffprobe and app workers.")


if __name__ == "__main__":
    prepare()
