"""Check the Squirrel feed and shipped app before publishing a Windows release.

Standard library only. This validates artifacts without executing an installer,
opening user data, contacting GitHub, or making a model request.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import struct
import xml.etree.ElementTree as ET
from zipfile import ZipFile

APP_ID = "threads_media_manager"
SETUP_NAME = "ThreadsMediaManager-win32-x64-Setup.exe"
EXE_NAME = "ThreadsMediaManager.exe"
ASAR_NAME = "lib/net45/resources/app.asar"
FORBIDDEN_NAMES = {
    "auth.json", "credentials.json", "threads-account.json", "file-server.json",
    "threads-publishing.json", "view-settings.json", "accounts.xlsx",
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def safe_name(name):
    normalized = name.replace("\\", "/")
    path = PurePosixPath(normalized)
    require(not path.is_absolute() and ".." not in path.parts and
            not any(":" in part for part in path.parts), f"Unsafe archive path: {name}")
    for part in path.parts:
        lower = part.lower()
        require(lower not in FORBIDDEN_NAMES and not lower.startswith(".env") and
                not re.search(r"\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm))?$", lower),
                f"User data or credentials in release: {name}")
    require(not ({".git", ".codex", ".aws"} & {part.lower() for part in path.parts}),
            f"Private configuration directory in release: {name}")
    return normalized


def asar_files(stream):
    prefix = stream.read(16)
    require(len(prefix) == 16, "Missing ASAR header")
    size_payload, header_size, header_payload, json_size = struct.unpack("<IIII", prefix)
    require(size_payload == 4 and 8 <= header_size <= 32 * 1024 * 1024 and
            header_payload + 4 == header_size and json_size <= header_size - 8,
            "Invalid ASAR header")
    raw = stream.read(header_size - 8)
    require(len(raw) == header_size - 8, "Truncated ASAR header")
    header = json.loads(raw[:json_size])
    files = {}

    def walk(entries, prefix=""):
        for name, entry in entries.items():
            relative = safe_name(prefix + name)
            if "files" in entry:
                walk(entry["files"], relative + "/")
            else:
                require("link" not in entry, f"Unexpected ASAR link: {relative}")
                files[relative] = entry
    walk(header["files"])
    return files, 8 + header_size


def asar_read(stream, files, content_start, name, limit=32 * 1024 * 1024):
    require(name in files, f"Missing shipped app file: {name}")
    entry = files[name]
    require(not entry.get("unpacked"), f"Expected packed app file: {name}")
    size, offset = entry["size"], int(entry["offset"])
    require(0 <= size <= limit and offset >= 0, f"Invalid app file range: {name}")
    stream.seek(content_start + offset)
    result = stream.read(size)
    require(len(result) == size, f"Truncated app file: {name}")
    return result


def verify_release(output, version, repository):
    require(re.fullmatch(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)", version),
            "Windows public releases require a stable major.minor.patch version")
    require(re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository),
            "Expected GitHub owner/repository")
    output = Path(output)
    package_name = f"{APP_ID}-{version}-full.nupkg"
    required = {SETUP_NAME, "RELEASES", package_name}
    names = {entry.name for entry in output.iterdir()}
    require(required <= names, "Missing Windows installer, RELEASES or versioned full package")
    require(names <= required | {"SHA256SUMS.txt", "verification.json"},
            "Unexpected release artifact; publish only the validated Windows assets")
    for name in names:
        path = output / name
        require(path.is_file() and not path.is_symlink(), f"Invalid artifact: {name}")
    with (output / SETUP_NAME).open("rb") as setup:
        require(setup.read(2) == b"MZ", "Windows setup is not a PE executable")
    lines = (output / "RELEASES").read_text(encoding="utf-8-sig").splitlines()
    require(len(lines) == 1, "RELEASES must contain exactly the current full package")
    fields = lines[0].split()
    require(len(fields) == 3 and re.fullmatch(r"[0-9a-fA-F]{40}", fields[0]),
            "Invalid Squirrel RELEASES entry")
    require(fields[1] == package_name, "RELEASES points to a different app or version")
    package = output / package_name
    require(fields[2].isdigit() and int(fields[2]) == package.stat().st_size,
            "RELEASES package size does not match")
    with package.open("rb") as file:
        require(hashlib.file_digest(file, "sha1").hexdigest() == fields[0].lower(),
                "RELEASES SHA-1 does not match the full package")
    with ZipFile(package) as archive:
        names = [safe_name(entry.filename) for entry in archive.infolist()]
        require(len(names) == len(set(names)), "Duplicate NuGet archive entries")
        nuspecs = [name for name in names if name.endswith(".nuspec")]
        require(nuspecs == [f"{APP_ID}.nuspec"], "Unexpected NuGet application ID")
        metadata = ET.fromstring(archive.read(nuspecs[0])).find("{*}metadata")
        require(metadata is not None, "Missing NuGet metadata")
        require(metadata.findtext("{*}id") == APP_ID, "NuGet application ID mismatch")
        require(metadata.findtext("{*}version") == version, "NuGet version mismatch")
        require(f"lib/net45/{EXE_NAME}" in names and ASAR_NAME in names,
                "Missing Windows application or app.asar")
        with archive.open(f"lib/net45/{EXE_NAME}") as executable:
            require(executable.read(2) == b"MZ", "Shipped app is not a Windows executable")
            executable.seek(0x3C)
            pointer = executable.read(4)
            require(len(pointer) == 4, "Missing PE header offset")
            executable.seek(struct.unpack("<I", pointer)[0])
            require(executable.read(6) == b"PE\x00\x00\x64\x86",
                    "Shipped app must be a Windows x64 executable")
        with archive.open(ASAR_NAME) as stream:
            files, content_start = asar_files(stream)
            metadata = json.loads(asar_read(stream, files, content_start, "package.json"))
            require(metadata.get("name") == "threads-media-manager", "Shipped package name mismatch")
            require(metadata.get("version") == version, "Shipped package version mismatch")
            main = asar_read(stream, files, content_start, ".webpack/main/index.js").decode("utf-8")
            require(repository in main and "update.electronjs.org" in main,
                    "Shipped updater does not contain the intended public GitHub feed")
    return {"version": version, "appId": APP_ID, "platform": "win32-x64",
            "repository": repository, "feed": f"https://update.electronjs.org/{repository}/win32-x64/{version}",
            "fullPackage": package_name, "feedIntegrity": "passed", "privateFileNames": "absent",
            "installerExecuted": False, "automaticUpdateTested": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default="out/make/squirrel.windows/x64")
    parser.add_argument("--package", default="package.json")
    parser.add_argument("--repository", required=True)
    args = parser.parse_args()
    metadata = json.loads(Path(args.package).read_text(encoding="utf-8"))
    print(json.dumps(verify_release(args.output, metadata["version"], args.repository)))


if __name__ == "__main__":
    main()
