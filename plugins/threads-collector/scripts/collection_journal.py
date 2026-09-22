#!/usr/bin/env python3
"""Offline append-only collection journal; Python standard library only.

The caller MUST own the collection root's _work/collector.lock for the whole run.
This helper does not acquire a second lock and does not support concurrent writers.
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
import sys
import tempfile
from typing import Any


class JournalError(ValueError):
    """Invalid input, journal corruption, or a failed durable write."""


INPUT_FIELDS = {"v", "type", "run_id", "account", "event_id", "payload"}
RECORD_FIELDS = INPUT_FIELDS | {"seq"}


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
        # under the caller's collector.lock; any partial failure stays on disk.
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
    append = commands.add_parser("append", help="Durably append one event under caller-owned collector.lock")
    append.add_argument("--journal", required=True, type=Path)
    append.add_argument("--input", required=True, type=Path, help="UTF-8 JSON record file (without seq)")
    read = commands.add_parser("read", help="Export complete records and recovery metadata without repairs")
    read.add_argument("--journal", required=True, type=Path)
    read.add_argument("--output", required=True, type=Path, help="Normalized snapshot JSON file")
    args = parser.parse_args(argv)
    try:
        if args.command == "append":
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
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (JournalError, OSError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
