#!/usr/bin/env python3
"""Export only reviewed collector files to the dedicated distribution checkout.

Does not create a GitHub repo, commit, push, install plugins or copy user data.
The caller owns Git review and publishing. Existing unrecognized paths fail closed.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("collector_package", ROOT / "scripts/package-collector.py")
package = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(package)
EXTRA = {
    ".agents/plugins/marketplace.json": "distribution/github/marketplace.json",
    "README.md": "distribution/github/README.md",
    "AGENTS.md": "distribution/github/AGENTS.md",
    ".gitignore": "distribution/github/gitignore.txt",
    ".gitattributes": "distribution/github/gitattributes.txt",
    ".github/workflows/check.yml": "distribution/github/check.yml",
    "scripts/verify-distribution.py": "distribution/github/verify-distribution.py",
    "tests/test_setup_collection.py": "tests/test_setup_collection.py",
    "tests/test_collection_source.py": "tests/test_collection_source.py",
    "tests/test_collection_journal.py": "tests/test_collection_journal.py",
}


def export(destination):
    destination = destination.resolve()
    if destination == ROOT or destination in ROOT.parents or ROOT in destination.parents:
        raise ValueError("Use a separate distribution directory outside the source checkout")
    files = {package.PLUGIN + "/" + name: package.PLUGIN + "/" + name for name in package.FILES}
    files.update(EXTRA)
    allowed = set(files) | {"DISTRIBUTION.json"}
    if destination.exists():
        for path in destination.rglob("*"):
            relative = path.relative_to(destination)
            if relative.parts[0] == ".git":
                continue
            if path.is_symlink() or (path.is_file() and relative.as_posix() not in allowed):
                raise ValueError(f"Unrecognized existing distribution path: {relative}")
    # Validate every input before writing anything.
    for relative in files.values():
        source = ROOT / relative
        if source.is_symlink() or not source.is_file() or not source.resolve().is_relative_to(ROOT):
            raise ValueError(f"Invalid export source: {relative}")
    for relative, source in files.items():
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / source, target)
    manifest = json.loads((destination / package.PLUGIN / ".codex-plugin/plugin.json").read_text(encoding="utf-8"))
    metadata = {"repository": "https://github.com/ilseong-xofl/threads-collector", "branch": "main",
                "plugin": manifest["name"], "version": manifest["version"],
                "sha256": {name: package.digest((destination / name).read_bytes()) for name in sorted(files)}}
    (destination / "DISTRIBUTION.json").write_text(json.dumps(metadata, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"destination": str(destination), "version": manifest["version"], "files": len(files) + 1}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path)
    export(parser.parse_args().destination)
