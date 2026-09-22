#!/usr/bin/env python3
"""Export one current post from verified local files without changing its library."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import stat
import sys
import tempfile
import zipfile

# The Electron worker runs with -I; import only this application's runtime.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from collection_view import EDIT_FORMAT, FILE, MAX_DRAFT_REVISION, InputError, read_snapshot
from threads_runner.parent_monitor import MonitorError, ParentMonitor
from threads_runner.deletion_state import require_no_pending
from threads_runner.state import StateError
from threads_source.files import SourceError, collection_root, no_symlinks, parse_json, safe_path

INPUT_LIMIT = 32 * 1024
CHUNK_SIZE = 1024 * 1024
KST = timezone(timedelta(hours=9))


class ExportError(ValueError):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


def signature(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns,
            info.st_ctime_ns, info.st_mode, info.st_nlink)


def cancelled(check):
    if check():
        raise ExportError("cancelled", "게시글 ZIP 저장을 취소했습니다.")


def regular(path):
    no_symlinks(path)
    info = path.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ExportError("invalid_file", "일반 파일만 ZIP으로 저장할 수 있습니다.")
    return signature(info)


def directory_signature(path):
    result = []
    for item in (path, *path.parents):
        info = item.lstat()
        if not stat.S_ISDIR(info.st_mode):
            raise ExportError("unsafe_destination", "ZIP 저장 폴더의 연결을 확인하세요.")
        result.append((str(item), info.st_dev, info.st_ino))
    return result


def destination_state(root, value):
    if not isinstance(value, str) or not value or "\x00" in value:
        raise ExportError("invalid_destination", "ZIP 저장 위치가 필요합니다.")
    path = Path(value)
    if not path.is_absolute() or ".." in path.parts or path.suffix.lower() != ".zip":
        raise ExportError("invalid_destination", "절대 경로의 ZIP 파일 저장 위치가 필요합니다.")
    no_symlinks(path)
    if path.resolve().is_relative_to(root):
        raise ExportError("collection_destination", "수집 폴더 밖에 ZIP 파일을 저장하세요.")
    parents = directory_signature(path.parent)
    existing = regular(path) if path.exists() else None
    return path, parents, existing


def validate_destination(root, path, parents, existing):
    current, current_parents, current_existing = destination_state(root, str(path))
    if current != path or current_parents != parents or current_existing != existing:
        raise ExportError("destination_changed", "ZIP 저장 위치가 변경되었습니다. 기존 파일을 보존했습니다.")


def selected_post(snapshot, post_key, expected_revision=None):
    if any(item.get("code") in {"invalid_edit", "edits_unavailable"} for item in snapshot["snapshot"].get("warnings", [])):
        raise ExportError("edits_unavailable", "편집 결과의 연결 정보가 손상되었거나 누락되었습니다. 편집 자료를 복구·확인한 뒤 ZIP을 다시 저장하세요. 원본 파일은 보존했습니다.")
    matches = [post for post in snapshot["snapshot"]["posts"] if post["key"] == post_key]
    if len(matches) != 1:
        raise ExportError("post_missing", "게시글을 찾을 수 없습니다. 목록을 새로고침하세요.")
    post = matches[0]
    attachments = [*post["attachments"], *post.get("edits", [])]
    if expected_revision is not None:
        if any(item.get("code") == "drafts_unavailable" for item in snapshot["snapshot"].get("warnings", [])):
            raise ExportError("drafts_unavailable", "등록 게시글을 읽을 수 없습니다. 저장 상태를 확인하세요.")
        draft = post.get("draft")
        if draft is None or draft["revision"] != expected_revision:
            raise ExportError("draft_conflict", "등록 게시글이 변경되었습니다. 최신 게시글을 다시 열어 다운로드하세요.")
        by_id = {item.get("mediaId"): item for item in attachments if item.get("mediaId")}
        if any(media_id not in by_id for media_id in draft["mediaIds"]):
            raise ExportError("attachments_incomplete", "선택한 첨부를 찾을 수 없습니다. 등록 게시글을 수정한 뒤 다운로드하세요.")
        attachments = [{**by_id[media_id], "ordinal": index} for index, media_id in enumerate(draft["mediaIds"], 1)]
        post = {**post, "caption": draft["caption"]}
    if not attachments:
        raise ExportError("attachments_missing", "저장할 이미지 또는 영상이 없습니다.")
    registered = {item["id"]: item for item in snapshot["files"]}
    files, seen_ordinals, seen_media = [], set(), set()
    for attachment in sorted(attachments, key=lambda item: item["ordinal"]):
        item = registered.get(attachment.get("mediaId"))
        ordinal = attachment.get("ordinal")
        if (attachment.get("status") != "saved" or not item or
                attachment.get("kind") not in {"image", "video"} or
                attachment["kind"] != item.get("kind") or
                type(ordinal) is not int or ordinal < 1 or ordinal in seen_ordinals or
                item["id"] in seen_media):
            raise ExportError("attachments_incomplete", "게시글의 이미지와 영상을 모두 저장한 뒤 ZIP으로 저장하세요.")
        match = FILE.fullmatch(item.get("relativePath", ""))
        if (not match or match[1] != item["id"] or
                (item["kind"] == "image") != (match[2] in {"jpg", "jpeg", "png", "webp", "gif"}) or
                type(item.get("size")) is not int or item["size"] <= 0 or
                not isinstance(item.get("sha256"), str) or not re.fullmatch(r"[0-9a-f]{64}", item["sha256"])):
            raise ExportError("invalid_local_path", "저장된 첨부 파일 연결을 확인하세요.")
        if attachment.get('editType') is not None:
            expected = EDIT_FORMAT.get(attachment['editType'])
            if not expected or expected != (item['kind'], match[2]):
                raise ExportError('invalid_edit', '편집 결과의 종류와 저장 형식을 확인하세요.')
        seen_ordinals.add(ordinal)
        seen_media.add(item["id"])
        files.append({**item, "archiveName": f"{ordinal:02d}.{match[2]}"})
    return post, files


def post_text(post):
    collected = post.get("collectedAt")
    if collected:
        try:
            date = datetime.fromisoformat(collected)
            if date.tzinfo is None:
                raise ValueError("missing zone")
            collected = date.astimezone(KST).strftime("%Y-%m-%d %H:%M:%S KST")
        except (TypeError, ValueError) as exc:
            raise ExportError("invalid_date", "게시글 수집일을 확인할 수 없습니다.") from exc
    else:
        collected = "확인되지 않음"
    return (f"계정명: @{post['account'].lstrip('@')}\n"
            f"수집일: {collected}\n"
            f"원문 주소: {post['originalUrl']}\n\n"
            f"캡션\n{post['caption']}").encode("utf-8")


def stable_snapshot(snapshot):
    return {"snapshot": {key: value for key, value in snapshot["snapshot"].items() if key != "loadedAt"},
            "files": snapshot["files"]}


def copy_media(archive, root, item, check):
    path = safe_path(root, item["relativePath"], require_file=True)
    before = regular(path)
    if before[2] != item["size"]:
        raise ExportError("local_file_changed", "저장된 첨부 파일이 변경되었습니다. ZIP을 만들지 않았습니다.")
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    digest, size = hashlib.sha256(), 0
    with os.fdopen(os.open(path, flags), "rb") as source:
        if signature(os.fstat(source.fileno())) != before:
            raise ExportError("local_file_changed", "읽는 중 첨부 파일이 변경되었습니다.")
        with archive.open(item["archiveName"], "w", force_zip64=True) as output:
            while True:
                cancelled(check)
                chunk = source.read(CHUNK_SIZE)
                if not chunk:
                    break
                size += len(chunk)
                if size > item["size"]:
                    raise ExportError("local_file_changed", "읽는 중 첨부 파일이 변경되었습니다.")
                digest.update(chunk)
                output.write(chunk)
        if signature(os.fstat(source.fileno())) != before:
            raise ExportError("local_file_changed", "읽는 중 첨부 파일이 변경되었습니다.")
    if regular(path) != before or size != item["size"] or digest.hexdigest() != item["sha256"]:
        raise ExportError("local_file_changed", "저장된 첨부 파일 검증에 실패했습니다. 기존 파일을 보존했습니다.")
    return before


def export_post(data, *, check=lambda: False):
    fields = {"root", "postKey", "destination"}
    if (not isinstance(data, dict) or set(data) not in (fields, fields | {"expectedRevision"}) or
            not all(isinstance(data[key], str) and data[key] for key in fields) or
            ("expectedRevision" in data and (type(data["expectedRevision"]) is not int or
                not 1 <= data["expectedRevision"] <= MAX_DRAFT_REVISION))):
        raise ExportError("invalid_request", "게시글 ZIP 저장 요청이 올바르지 않습니다.")
    root = collection_root(Path(data["root"]))
    require_no_pending(root)
    destination, parents, existing = destination_state(root, data["destination"])
    cancelled(check)
    snapshot = read_snapshot(root)
    post, files = selected_post(snapshot, data["postKey"], data.get("expectedRevision"))
    metadata = post_text(post)
    cancelled(check)
    validate_destination(root, destination, parents, existing)
    temporary = None
    identity = None
    try:
        descriptor, name = tempfile.mkstemp(prefix=".threads-export-", suffix=".tmp", dir=destination.parent)
        temporary = Path(name)
        with os.fdopen(descriptor, "w+b") as output:
            identity = os.fstat(output.fileno())
            validate_destination(root, destination, parents, existing)
            media_stamps = []
            with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=1, allowZip64=True) as archive:
                for item in files:
                    media_stamps.append(copy_media(archive, root, item, check))
                archive.writestr("게시글정보.txt", metadata)
            output.flush()
            os.fsync(output.fileno())
        cancelled(check)
        # Re-read the authoritative source and read-only DB, including file hashes.
        # No collection lock/DB writes are needed; a concurrent active owner blocks this read.
        if stable_snapshot(read_snapshot(root)) != stable_snapshot(snapshot):
            raise ExportError("source_changed", "저장하는 동안 게시글 정보가 바뀌었습니다. 목록을 새로고침하세요.")
        for item, before in zip(files, media_stamps):
            if regular(safe_path(root, item["relativePath"], require_file=True)) != before:
                raise ExportError("local_file_changed", "저장하는 동안 첨부 파일이 변경되었습니다.")
        temp_info = regular(temporary)
        if temp_info[:2] != (identity.st_dev, identity.st_ino):
            raise ExportError("temporary_changed", "ZIP 임시 파일이 변경되었습니다.")
        validate_destination(root, destination, parents, existing)
        cancelled(check)
        os.replace(temporary, destination)
        temporary = None
        return {"ok": True, "fileName": destination.name}
    finally:
        if temporary is not None:
            # Only remove the specific temporary file created by this invocation.
            try:
                current = temporary.lstat()
                if identity is not None and (current.st_dev, current.st_ino) == (identity.st_dev, identity.st_ino):
                    temporary.unlink()
            except FileNotFoundError:
                pass


def main():
    stopped = False
    monitor = None

    def stop(*_):
        nonlocal stopped
        stopped = True

    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, stop)
    try:
        monitor = ParentMonitor()
        raw = sys.stdin.buffer.read(INPUT_LIMIT + 1)
        if not raw or len(raw) > INPUT_LIMIT:
            raise ExportError("invalid_request", "게시글 ZIP 저장 요청이 올바르지 않습니다.")
        result = export_post(parse_json(raw), check=lambda: stopped or monitor.cancelled())
    except (ExportError, SourceError, InputError, MonitorError, StateError) as exc:
        result = {"ok": False, "error": {"code": exc.code, "message": str(exc)}}
    except Exception:
        result = {"ok": False, "error": {"code": "export_failed", "message": "ZIP을 저장하지 못했습니다. 기존 파일은 보존했습니다."}}
    finally:
        if monitor is not None:
            monitor.close()
    print(json.dumps(result, ensure_ascii=False, allow_nan=False), flush=True)
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
