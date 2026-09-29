"""Build-only downloads; the installed app never installs Python or packages."""
from pathlib import Path, PurePosixPath
import hashlib
import json
import shutil
import sys
import tarfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def unpack_codex_package(archive_path, destination):
    """Preserve the official native layout, including helpers and component licenses."""
    prefix = PurePosixPath("package/vendor/x86_64-pc-windows-msvc")
    with tarfile.open(archive_path, "r:gz") as archive:
        for member in archive.getmembers():
            path = PurePosixPath(member.name)
            if ".." in path.parts or path.is_absolute() or any("\\" in part or ":" in part for part in path.parts):
                raise RuntimeError("Unsafe Codex package path")
            if not path.is_relative_to(prefix):
                continue
            relative = path.relative_to(prefix)
            if not member.isfile() or not relative.parts:
                raise RuntimeError("Unexpected Codex package entry: " + member.name)
            target = destination.joinpath(*relative.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.extractfile(member) as source, target.open("wb") as output:
                shutil.copyfileobj(source, output)


def verify_codex_package(destination, manifest):
    metadata = json.loads((destination / "codex-package.json").read_text(encoding="utf-8"))
    expected = {
        "layoutVersion": 1, "version": manifest["codexVersion"],
        "target": "x86_64-pc-windows-msvc", "variant": "codex",
        "entrypoint": "bin/codex.exe", "resourcesDir": "codex-resources", "pathDir": "codex-path",
    }
    if metadata != expected:
        raise RuntimeError("Unexpected Codex package metadata")
    for relative in manifest["codexRequiredFiles"]:
        if not (destination / relative).is_file():
            raise RuntimeError("Missing Codex package file: " + relative)
    files = []
    for path in sorted(destination.rglob("*")):
        if path.is_file() and path.name != "runtime-files.json":
            data = path.read_bytes()
            files.append({"path": path.relative_to(destination).as_posix(),
                          "size": len(data), "sha256": hashlib.sha256(data).hexdigest()})
    (destination / "runtime-files.json").write_text(json.dumps(files, indent=2) + "\n", encoding="utf-8")


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
        elif item["name"] == "codex.tgz":
            unpack_codex_package(target, output / "codex")
        elif item["name"] in {"codex.LICENSE", "codex.NOTICE"}:
            shutil.copy2(target, output / "codex" / item["name"].removeprefix("codex."))
        elif item["name"] == "ripgrep.LICENSE-MIT":
            shutil.copy2(target, output / "codex/codex-path" / item["name"])
        else:
            shutil.copy2(target, output / "bin" / item["name"])
    verify_codex_package(output / "codex", manifest)
    # Isolated application-local imports, independent of registry/PYTHONPATH/user packages.
    (output / "python/python313._pth").write_text("python313.zip\n.\nLib/site-packages\n", encoding="utf-8")
    for directory in ("local-runtime", "plugins/threads-collector/scripts"):
        for source in (ROOT / directory).rglob("*.py"):
            destination = output / source.relative_to(ROOT)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
    shutil.copy2(ROOT / "scripts/windows-runtime.json", output / "runtime-manifest.json")
    print("Bundled Python, Pillow, SQLite, ffmpeg, ffprobe, Codex CLI and app workers.")


if __name__ == "__main__":
    prepare()
