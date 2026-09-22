"""Read-only validator for retired threads-source-v1 JSONL backups.

Not used by collection, app snapshots, or downloads. Never writes a ledger.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re

from .files import SourceError, read_stable, safe_path

MAX_BYTES = 64 * 1024 * 1024
COMMITTED = {"initial_complete", "anchor_reached", "cap_reached", "end_reached"}


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8") + b"\n"


def _pairs(pairs):
    out = {}
    for key, value in pairs:
        if key in out:
            raise SourceError("jsonl_corrupt", "JSONL에 중복 필드가 있습니다.")
        out[key] = value
    return out


def read_ledger(path: Path):
    raw = read_stable(path, max_bytes=MAX_BYTES)
    if raw and not raw.endswith(b"\n"):
        raise SourceError("jsonl_incomplete", "JSONL 마지막 기록이 미완료입니다. 원본을 보존했습니다.")
    transactions, pending = [], []
    expected_seq = 1
    for line in raw.splitlines():
        try:
            item = json.loads(line, object_pairs_hook=_pairs, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        except (ValueError, UnicodeError, RecursionError) as exc:
            raise SourceError("jsonl_corrupt", "JSONL 기록을 해석할 수 없습니다.") from exc
        if (not isinstance(item, dict) or item.get("schema") != "threads-source-v1" or
                type(item.get("seq")) is not int or item["seq"] != expected_seq or
                item.get("type") not in {"begin", "post", "media", "commit"}):
            raise SourceError("jsonl_corrupt", "JSONL 버전·순서·기록 유형이 올바르지 않습니다.")
        expected_seq += 1
        if item["type"] == "begin":
            if pending or not isinstance(item.get("payload"), dict):
                raise SourceError("jsonl_corrupt", "중첩되거나 잘못된 JSONL 실행입니다.")
            pending = [item]
        elif not pending or item.get("run_id") != pending[0].get("run_id") or item.get("account") != pending[0].get("account"):
            raise SourceError("jsonl_corrupt", "JSONL 실행 연결이 맞지 않습니다.")
        elif item["type"] == "commit":
            body = b"".join(encoded(x) for x in pending)
            if item.get("sha256") != hashlib.sha256(body).hexdigest():
                raise SourceError("jsonl_corrupt", "JSONL 확정 기록의 해시가 맞지 않습니다.")
            transactions.append(pending)
            pending = []
        else:
            if not isinstance(item.get("payload"), dict):
                raise SourceError("jsonl_corrupt", "JSONL 데이터가 올바르지 않습니다.")
            pending.append(item)
    if pending:
        raise SourceError("jsonl_incomplete", "확정되지 않은 JSONL 실행이 있습니다.")
    return {"transactions": transactions, "next_seq": expected_seq,
            "source_sha256": hashlib.sha256(raw).hexdigest()}


def load_collection(root: Path):
    from .excel_input import validate_records, merge_validated_sources
    batches, sources = [], []
    results = safe_path(root, "results")
    paths = []
    if results.exists():
        if not results.is_dir():
            raise SourceError("invalid_source", "results 경로는 일반 폴더여야 합니다.")
        for year in sorted(results.iterdir()):
            if not re.fullmatch(r"\d{4}", year.name):
                continue
            safe_path(root, year.relative_to(root).as_posix())
            if not year.is_dir():
                continue
            for month in sorted(year.iterdir()):
                if not re.fullmatch(r"\d{2}", month.name):
                    continue
                safe_path(root, month.relative_to(root).as_posix())
                if not month.is_dir():
                    continue
                paths.extend(sorted(month.glob("threads-*.jsonl")))
                if len(paths) > 10_000:
                    raise SourceError("input_limit", "영구 수집 원본 파일 수 제한을 초과했습니다.")
    for path in paths:
        rel = path.relative_to(root).as_posix()
        if not re.fullmatch(r"results/\d{4}/\d{2}/threads-\d{4}-\d{2}-\d{2}\.jsonl", rel):
            continue
        safe_path(root, rel, require_file=True)
        from .excel_input import _source_date
        _source_date(rel.removesuffix(".jsonl") + ".xlsx")
        data = read_ledger(path)
        sources.append({"relative_path": rel, "sha256": data["source_sha256"]})
        for tx in data["transactions"]:
            posts, media = [], []
            meta = {"_source": rel, "_source_sha256": data["source_sha256"]}
            raw_run = tx[0]["payload"].get("run")
            if not isinstance(raw_run, dict):
                raise SourceError("jsonl_corrupt", "JSONL 실행 필드가 올바르지 않습니다.")
            run = dict(raw_run, **meta)
            if run.get("실행ID") != tx[0]["run_id"] or run.get("계정명") != tx[0]["account"]:
                raise SourceError("jsonl_corrupt", "JSONL 실행 메타데이터가 맞지 않습니다.")
            if str(run.get("수집일자(KST)", ""))[:10] != path.stem.removeprefix("threads-"):
                raise SourceError("run_date_mismatch", "JSONL 수집일과 파일명이 다릅니다.")
            for rec in tx[1:]:
                value = dict(rec["payload"], **meta)
                if value.get("계정명") != tx[0]["account"] or value.get("확인실행ID") != tx[0]["run_id"]:
                    raise SourceError("jsonl_corrupt", "JSONL 원문과 실행 연결이 맞지 않습니다.")
                (posts if rec["type"] == "post" else media).append(value)
            batch = validate_records(posts, media, [run])
            for kind in ("posts", "media", "runs"):
                for record in batch[kind]:
                    record.update(meta)
            batches.append(batch)
    result = merge_validated_sources(batches)
    result["sources"] = sources
    return result
