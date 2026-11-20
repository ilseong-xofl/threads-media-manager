"""Check the Squirrel feed and shipped app before publishing a Windows release.

Standard library only. This validates artifacts without executing an installer,
opening user data, contacting GitHub, or making a model request.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import mmap
from pathlib import Path, PurePosixPath
import re
import struct
import xml.etree.ElementTree as ET
from zipfile import ZipFile

VARIANTS_PATH = Path(__file__).resolve().parents[1] / "variants.json"
ASAR_NAME = "lib/net45/resources/app.asar"
FORBIDDEN_NAMES = {
    "auth.json", "credentials.json", "threads-account.json", "file-server.json",
    "threads-publishing.json", "view-settings.json", "accounts.xlsx", "meta-token-checks.log",
    "daily.json", "draft-notes.json",
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def load_variants():
    return json.loads(VARIANTS_PATH.read_text(encoding="utf-8"))


def has_name(text, value):
    """Whole-name search: the dev update repository is the start of the prod one."""
    return re.search(rf"(?<![A-Za-z0-9_.-]){re.escape(value)}(?![A-Za-z0-9_.-])", text) is not None


def has_literal(text, value):
    return any(f"{quote}{value}{quote}" in text for quote in "\"'`")


def has_version_string(binary, key, value):
    """Whole entry of the version resource (UTF-16): key, terminator and padding, then the value.

    One variant's product name is part of the other's and equals its company name, so a search
    for the bare name would find it in both executables.
    """
    return re.search(re.escape(key.encode("utf-16-le")) + rb"(?:\x00\x00)+" +
                     re.escape(value.encode("utf-16-le")) + rb"\x00\x00", binary) is not None


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


def verify_release(output, version, variant_name, variants=None):
    """Every expected name, the service and the update repository come from variants.json."""
    variants = load_variants() if variants is None else variants
    require(variant_name in variants, f"Unknown build variant: {variant_name!r}")
    variant = variants[variant_name]
    others = [value for name, value in variants.items() if name != variant_name]
    app_id, setup_name = variant["squirrelName"], variant["setupExe"]
    exe_name = f"{variant['executableName']}.exe"
    repository, service_url = variant["updateRepository"], variant["serviceUrl"]
    require(re.fullmatch(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)", version),
            "Windows public releases require a stable major.minor.patch version")
    require(re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository),
            "Expected GitHub owner/repository")
    require(re.fullmatch(r"https://[A-Za-z0-9.-]+(?::[0-9]{1,5})?", service_url),
            "Service URL must be an HTTPS origin")
    output = Path(output)
    package_name = f"{app_id}-{version}-full.nupkg"
    required = {setup_name, "RELEASES", package_name}
    names = {entry.name for entry in output.iterdir()}
    require(required <= names, "Missing Windows installer, RELEASES or versioned full package")
    require(names <= required | {"SHA256SUMS.txt", "verification.json"},
            "Unexpected release artifact; publish only the validated Windows assets")
    for name in names:
        path = output / name
        require(path.is_file() and not path.is_symlink(), f"Invalid artifact: {name}")
    with (output / setup_name).open("rb") as setup:
        require(setup.read(2) == b"MZ", "Windows setup is not a PE executable")
        # Squirrel stores the full package in Setup.exe under its file name.
        with mmap.mmap(setup.fileno(), 0, access=mmap.ACCESS_READ) as data:
            require(data.find(package_name.encode()) != -1,
                    "Windows setup does not carry this variant's full package")
            for other in others:
                require(data.find(f"{other['squirrelName']}-{version}-full.nupkg".encode()) == -1,
                        "Windows setup carries another variant's package")
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
        require(nuspecs == [f"{app_id}.nuspec"], "Unexpected NuGet application ID")
        metadata = ET.fromstring(archive.read(nuspecs[0])).find("{*}metadata")
        require(metadata is not None, "Missing NuGet metadata")
        require(metadata.findtext("{*}id") == app_id, "NuGet application ID mismatch")
        require(metadata.findtext("{*}version") == version, "NuGet version mismatch")
        # Windows lists the installed program under this title and publisher.
        require(metadata.findtext("{*}title") == variant["productName"] and
                metadata.findtext("{*}authors") == variant["companyName"],
                "NuGet title or authors belong to another variant")
        require(f"lib/net45/{exe_name}" in names and ASAR_NAME in names,
                "Missing Windows application or app.asar")
        require(not any(f"lib/net45/{other['executableName']}.exe" in names for other in others),
                "Package carries another variant's application")
        binary = archive.read(f"lib/net45/{exe_name}")
        require(binary[:2] == b"MZ", "Shipped app is not a Windows executable")
        pointer = binary[0x3C:0x40]
        require(len(pointer) == 4, "Missing PE header offset")
        offset = struct.unpack("<I", pointer)[0]
        require(binary[offset:offset + 6] == b"PE\x00\x00\x64\x86",
                "Shipped app must be a Windows x64 executable")
        # The version resource names the product. A dev executable renamed into a prod
        # package, or the reverse, would install under the wrong program name.
        require(has_version_string(binary, "ProductName", variant["productName"]),
                "Shipped app does not carry this variant's product name")
        require(not any(has_version_string(binary, "ProductName", other["productName"])
                        for other in others),
                "Shipped app carries another variant's product name")
        with archive.open(ASAR_NAME) as stream:
            files, content_start = asar_files(stream)
            metadata = json.loads(asar_read(stream, files, content_start, "package.json"))
            require(metadata.get("name") == "threads-media-manager", "Shipped package name mismatch")
            require(metadata.get("version") == version, "Shipped package version mismatch")
            main = asar_read(stream, files, content_start, ".webpack/main/index.js").decode("utf-8")
            require(has_literal(main, repository) and "update.electronjs.org" in main,
                    "Shipped updater does not contain the intended public GitHub feed")
            # The app locks without its service, so the origin must be exactly this variant's.
            require(has_literal(main, service_url),
                    "Shipped app does not contain the intended service URL")
            for other in others:
                require(not has_name(main, other["updateRepository"]),
                        "Shipped app contains another variant's update repository")
                require(not has_name(main, other["serviceUrl"]),
                        "Shipped app contains another variant's service URL")
    return {"variant": variant_name, "version": version, "appId": app_id, "platform": "win32-x64",
            "repository": repository, "feed": f"https://update.electronjs.org/{repository}/win32-x64/{version}",
            "serviceUrl": service_url,
            "fullPackage": package_name, "feedIntegrity": "passed", "privateFileNames": "absent",
            "installerExecuted": False, "automaticUpdateTested": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default="out/make/squirrel.windows/x64")
    parser.add_argument("--package", default="package.json")
    parser.add_argument("--variant", required=True)
    args = parser.parse_args()
    metadata = json.loads(Path(args.package).read_text(encoding="utf-8"))
    print(json.dumps(verify_release(args.output, metadata["version"], args.variant)))


if __name__ == "__main__":
    main()
