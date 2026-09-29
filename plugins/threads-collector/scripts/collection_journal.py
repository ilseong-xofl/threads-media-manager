#!/usr/bin/env python3
"""Offline append-only collection journal; Python standard library only.

Prepare the run directory before opening the browser or creating input records.
Each run/account journal has one writer; exploration does not hold collector.lock.
The source commit helper owns that lock only while publishing Excel files.
It neither reads the browser nor accesses the network, Excel, or downloaded media.

Input records contain v=1, type=start|batch|end, run_id, account, event_id, payload.
The caller uses one stable event_id per extraction/event; the helper assigns seq.
An exact retry is a no-op, including a retry after the journal has been closed.
New events after end, damaged journals, and event_id conflicts are rejected.
"""

from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import re
import sys
import tempfile
from typing import Any


class JournalError(ValueError):
    """Invalid input, journal corruption, or a failed durable write."""


INPUT_FIELDS = {"v", "type", "run_id", "account", "event_id", "payload"}
RECORD_FIELDS = INPUT_FIELDS | {"seq"}


def prepare_run(collection_root: Path, run_id: str) -> dict[str, Any]:
    """Prepare and probe only a run's temporary directory before browser access."""
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", run_id) or re.fullmatch(
        r"CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]", run_id, flags=re.IGNORECASE
    ):
        raise JournalError("Use a unique run ID containing only letters, digits, hyphens and underscores")
    if not collection_root.is_absolute() or collection_root.is_symlink() or not collection_root.is_dir():
        raise JournalError("Collection root must be an existing absolute directory; run setup first")
    root = collection_root.resolve()
    if any((path / ".codex-plugin/plugin.json").is_file() for path in (root, *root.parents)):
        raise JournalError("Use user storage outside the plugin source or installation cache")
    accounts = root / "accounts.xlsx"
    if accounts.is_symlink() or not accounts.is_file():
        raise JournalError("Existing accounts.xlsx is required; preparation never recreates user data")
    work = root / "_work"
    directory = work / run_id
    for path in (work, directory):
        if path.is_symlink() or getattr(path, "is_junction", lambda: False)():
            raise JournalError("Temporary directory must not be a link")
        if path.exists() and not path.is_dir():
            raise JournalError("A file occupies the temporary directory; existing data was preserved")
    if directory.exists() and any(directory.iterdir()):
        raise JournalError("Run directory is not empty; inspect existing recovery data before using a new run ID")
    try:
        directory.mkdir(parents=True, exist_ok=True)
        # Windows permits removal only after all handles have closed. A unique
        # probe never touches accounts, history, existing journals or the lock.
        with tempfile.NamedTemporaryFile(dir=directory, prefix=".prepare-", delete=False) as stream:
            probe = Path(stream.name)
            try:
                stream.write(b"threads-collector-write-probe\n")
                stream.flush()
                os.fsync(stream.fileno())
            finally:
                stream.close()
                probe.unlink()
    except OSError as exc:
        raise JournalError("Cannot prepare writable temporary storage; stop before opening the browser") from exc
    return {"operation": "prepare", "prepared": True, "run_directory": str(directory)}


def _json_tree(value: Any) -> None:
    if value is None or isinstance(value, (str, bool, int)):
        return
    if isinstance(value, float):
        if not math.isfinite(value):
            raise JournalError("JSON numbers must be finite")
        return
    if isinstance(value, list):
        for item in value:
            _json_tree(item)
        return
    if isinstance(value, dict) and all(isinstance(key, str) for key in value):
        for item in value.values():
            _json_tree(item)
        return
    raise JournalError("Input must contain only JSON values and string object keys")


def _encode(value: Any, *, canonical: bool = False) -> bytes:
    try:
        _json_tree(value)
        return json.dumps(
            value, ensure_ascii=False, allow_nan=False,
            separators=(",", ":"), sort_keys=canonical,
        ).encode("utf-8")
    except (TypeError, ValueError, UnicodeError, RecursionError) as exc:
        if isinstance(exc, JournalError):
            raise
        raise JournalError("Input is not valid finite UTF-8 JSON") from exc


def _object_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise JournalError("Duplicate JSON object key")
        result[key] = value
    return result


def _reject_constant(_value: str) -> None:
    raise JournalError("JSON numbers must be finite")


def _decode(raw: bytes, context: str) -> Any:
    try:
        value = json.loads(
            raw.decode("utf-8"), object_pairs_hook=_object_pairs,
            parse_constant=_reject_constant,
        )
        _encode(value)  # Reject overflowed floats and non-UTF-8 surrogate strings.
        return value
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise JournalError(f"{context}: invalid finite UTF-8 JSON") from exc


def _validate(record: Any, *, persisted: bool) -> None:
    expected = RECORD_FIELDS if persisted else INPUT_FIELDS
    if not isinstance(record, dict) or set(record) != expected:
        raise JournalError("Unexpected record fields (seq is assigned by the helper)")
    if type(record["v"]) is not int or record["v"] != 1:
        raise JournalError("Record v must be integer 1")
    if record["type"] not in ("start", "batch", "end"):
        raise JournalError("Record type must be start, batch, or end")
    for field in ("run_id", "account", "event_id"):
        if not isinstance(record[field], str) or not record[field].strip():
            raise JournalError(f"Record {field} must be a nonempty string")
    if not isinstance(record["payload"], dict):
        raise JournalError("Record payload must be an object")
    if persisted and (type(record["seq"]) is not int or record["seq"] < 1):
        raise JournalError("Record seq must be a positive integer")
    _encode(record)


def read_journal(journal: Path) -> dict[str, Any]:
    """Read only complete lines; report, never repair, an incomplete last line."""
    try:
        raw = journal.read_bytes()
    except OSError as exc:
        raise JournalError("Cannot read journal") from exc
    records: list[dict[str, Any]] = []
    identities: set[str] = set()
    valid_bytes = 0
    # Splitting on LF specifically avoids treating characters inside captions as
    # record delimiters. A non-newline tail is uncommitted even if it parses.
    parts = raw.split(b"\n")
    for line_number, part in enumerate(parts[:-1], start=1):
        record = _decode(part, f"Journal line {line_number}")
        _validate(record, persisted=True)
        if record["seq"] != len(records) + 1:
            raise JournalError(f"Journal line {line_number}: nonconsecutive seq")
        if not records:
            if record["type"] != "start":
                raise JournalError("Journal must begin with start")
        else:
            if records[-1]["type"] == "end":
                raise JournalError("Journal contains records after end")
            if record["type"] == "start":
                raise JournalError("Journal contains a repeated start")
            first = records[0]
            if (record["run_id"], record["account"]) != (first["run_id"], first["account"]):
                raise JournalError("Journal contains mixed run/account identities")
        if record["event_id"] in identities:
            raise JournalError("Journal contains repeated event_id")
        identities.add(record["event_id"])
        records.append(record)
        valid_bytes += len(part) + 1
    tail_bytes = len(parts[-1])
    first = records[0] if records else None
    return {
        "v": 1,
        "records": records,
        "recovery": {
            "incomplete_tail": tail_bytes > 0,
            "valid_bytes": valid_bytes,
            "tail_bytes": tail_bytes,
            "total_bytes": len(raw),
            "empty_journal": len(raw) == 0,
        },
        "state": {
            "run_id": first["run_id"] if first else None,
            "account": first["account"] if first else None,
            "next_seq": len(records) + 1,
            "closed": bool(records and records[-1]["type"] == "end"),
        },
    }


def append_record(journal: Path, record: dict[str, Any]) -> dict[str, Any]:
    """Validate fully before writing; never truncate, rewrite, or repair a journal."""
    _validate(record, persisted=False)
    # lexists also treats dangling symlinks as existing and never replaces them.
    exists = os.path.lexists(journal)
    if exists:
        snapshot = read_journal(journal)
        if snapshot["recovery"]["incomplete_tail"] or not snapshot["records"]:
            raise JournalError("Journal has an incomplete tail or no complete start; append refused")
        state = snapshot["state"]
        if (record["run_id"], record["account"]) != (state["run_id"], state["account"]):
            raise JournalError("Append run/account identity does not match journal")
        for previous in snapshot["records"]:
            if previous["event_id"] == record["event_id"]:
                supplied = {key: previous[key] for key in INPUT_FIELDS}
                if _encode(supplied, canonical=True) != _encode(record, canonical=True):
                    raise JournalError("event_id was already used with different content")
                return {"operation": "append", "appended": False, "deduplicated": True,
                        "seq": previous["seq"], "type": previous["type"]}
        if state["closed"]:
            raise JournalError("Journal is closed; append refused")
        if record["type"] == "start":
            raise JournalError("Start requires a new journal")
        sequence = state["next_seq"]
    else:
        if record["type"] != "start":
            raise JournalError("A new journal must begin with start")
        sequence = 1
    persisted = dict(record, seq=sequence)
    data = _encode(persisted) + b"\n"
    try:
        # Exclusive creation protects an existing file. Subsequent writes append
        # by the run's sole writer; any partial failure stays on disk.
        with journal.open("ab" if exists else "xb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
    except OSError as exc:
        raise JournalError("Journal write/fsync failed; stop collection and inspect recovery state") from exc
    return {"operation": "append", "appended": True, "deduplicated": False,
            "seq": sequence, "type": record["type"]}


def write_snapshot(journal: Path, output: Path, snapshot: dict[str, Any]) -> None:
    """Publish read output atomically while prohibiting overwriting the journal."""
    if journal.resolve() == output.resolve() or (output.exists() and os.path.samefile(journal, output)):
        raise JournalError("Snapshot output must not be the journal")
    temporary: str | None = None
    try:
        with tempfile.NamedTemporaryFile(mode="wb", dir=output.parent, prefix=".journal-read-", delete=False) as stream:
            temporary = stream.name
            stream.write(_encode(snapshot) + b"\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, output)
        temporary = None
    except OSError as exc:
        raise JournalError("Cannot publish journal snapshot") from exc
    finally:
        if temporary is not None:
            try:
                os.unlink(temporary)
            except OSError:
                pass


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    prepare = commands.add_parser("prepare", help="Create and probe temporary storage before browser access")
    prepare.add_argument("--collection-root", required=True, type=Path)
    prepare.add_argument("--run-id", required=True)
    append = commands.add_parser("append", help="Durably append one event to a single-writer journal")
    append.add_argument("--journal", required=True, type=Path)
    append.add_argument("--input", required=True, type=Path, help="UTF-8 JSON record file (without seq)")
    read = commands.add_parser("read", help="Export complete records and recovery metadata without repairs")
    read.add_argument("--journal", required=True, type=Path)
    read.add_argument("--output", required=True, type=Path, help="Normalized snapshot JSON file")
    args = parser.parse_args(argv)
    try:
        if args.command == "prepare":
            result = prepare_run(args.collection_root, args.run_id)
        elif args.command == "append":
            try:
                raw_input = args.input.read_bytes()
            except OSError as exc:
                raise JournalError("Cannot read input record file") from exc
            result = append_record(args.journal, _decode(raw_input, "Input"))
        else:
            snapshot = read_journal(args.journal)
            write_snapshot(args.journal, args.output, snapshot)
            result = {"operation": "read", "record_count": len(snapshot["records"]),
                      "closed": snapshot["state"]["closed"], "recovery": snapshot["recovery"]}
        # Captions, account identities, and media URLs belong only in files.
        # Keep machine-readable paths portable to redirected Windows consoles.
        print(json.dumps(result, ensure_ascii=True))
        return 0
    except (JournalError, OSError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=True), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
