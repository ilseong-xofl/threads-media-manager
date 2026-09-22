#!/usr/bin/env python3
"""Collection-only Excel source commands. Never opens a download DB or network."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

from threads_source import service
from threads_source.excel_input import InputError
from threads_source.files import SourceError


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--collection-root", type=Path, required=True)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("inspect")
    commit = commands.add_parser("commit-source")
    commit.add_argument("--input", type=Path, required=True)
    commit.add_argument("--lock-token")
    commit.add_argument("--journal", type=Path, help="Closed owned journal; removed with input only after verified Excel commit")
    args = parser.parse_args(argv)
    try:
        if args.command == "inspect":
            result = service.inspect_source(args.collection_root)
        elif args.command == "commit-source":
            result = service.commit_source(args.collection_root, args.input, lock_token=args.lock_token, journal_path=args.journal)
        print(json.dumps({"ok": True, **result}, ensure_ascii=False))
        return 0
    except Exception as exc:
        safe = isinstance(exc, (SourceError, InputError))
        print(json.dumps({"ok": False, "error": {
            "code": getattr(exc, "code", "collection_error") if safe else "collection_error",
            "message": str(exc) if safe else "수집 원본 처리를 중단했습니다. 기존 자료를 보존했습니다.",
        }}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
