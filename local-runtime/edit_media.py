#!/usr/bin/env python3
"""Append a cropped image or captured video frame; never modify a source file/job."""
from __future__ import annotations

import base64
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import io
import json
import math
import os
from pathlib import Path
import signal
import sqlite3
import sys
import uuid
import warnings

sys.path.insert(0, str(Path(__file__).resolve().parent))
import collection_view as view
import edit_schema
import video_trim
from export_post import stable_snapshot
from threads_runner.parent_monitor import MonitorError, ParentMonitor
from threads_runner.deletion_state import require_no_pending
from threads_runner.state import StateError
from threads_source.files import CollectionLock, SourceError, collection_root, parse_json, read_stable, safe_path, sync_directory

INPUT_LIMIT = 90 * 1024 * 1024
IMAGE_BYTES = 64 * 1024 * 1024
MAX_SIDE = 8192
MAX_PIXELS = 40_000_000


class EditError(ValueError):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


def cancelled(check):
    if check():
        raise EditError("cancelled", "미디어 편집 저장을 취소했습니다.")


def validate_request(data):
    if not isinstance(data, dict):
        raise EditError("invalid_request", "미디어 편집 요청이 올바르지 않습니다.")
    fields = {"root", "postKey", "mediaId", "kind"}
    kind = data.get("kind")
    extra = {"crop": {"crop"}, "capture": {"pngBase64", "time"}, "trim": {"start", "end"}}
    if (kind not in extra or set(data) != fields | extra[kind] or
            not all(isinstance(data.get(key), str) and data[key] for key in fields) or
            not view.UUID.fullmatch(data["mediaId"]) or len(data["postKey"]) > 512):
        raise EditError("invalid_request", "미디어 편집 요청이 올바르지 않습니다.")
    if kind == "crop":
        crop = data["crop"]
        if (not isinstance(crop, dict) or set(crop) != {"x", "y", "width", "height"} or
                any(type(value) is not int for value in crop.values()) or crop["x"] < 0 or crop["y"] < 0 or
                crop["width"] <= 0 or crop["height"] <= 0):
            raise EditError("invalid_crop", "이미지 안의 올바른 자르기 영역을 선택하세요.")
    elif kind == "trim":
        if (any(type(data[value]) not in (int, float) or not math.isfinite(data[value]) for value in ("start", "end")) or
                data["start"] < 0 or data["end"] <= data["start"]):
            raise EditError("invalid_trim", "시작 시간은 0 이상, 종료 시간은 시작 시간보다 커야 합니다.")
    elif (not isinstance(data["pngBase64"], str) or not data["pngBase64"] or len(data["pngBase64"]) > (IMAGE_BYTES+2)//3*4 or
            type(data["time"]) not in (int, float) or not math.isfinite(data["time"]) or data["time"] < 0):
        raise EditError("invalid_capture", "영상 캡처 정보가 올바르지 않습니다.")


def source_file(snapshot, data):
    post = next((item for item in snapshot["snapshot"]["posts"] if item["key"] == data["postKey"]), None)
    if post is None:
        raise EditError("post_missing", "게시글을 찾을 수 없습니다. 목록을 새로고침하세요.")
    attachment = next((item for item in [*post["attachments"], *post.get("edits", [])] if item.get("mediaId") == data["mediaId"]), None)
    item = next((item for item in snapshot["files"] if item["id"] == data["mediaId"]), None)
    kind = "image" if data["kind"] == "crop" else "video"
    if not attachment or not item or attachment["status"] != "saved" or attachment["kind"] != kind or item["kind"] != kind:
        raise EditError("edit_source_unavailable", "이 게시글에 저장된 원본 미디어를 확인하세요.")
    return post, item


class BoundedOutput(io.BytesIO):
    def write(self, value):
        if self.tell() + len(value) > IMAGE_BYTES:
            raise EditError("image_limit", "편집 결과가 64MiB를 초과합니다.")
        return super().write(value)


def dimensions(image):
    width, height = image.size
    if not 0 < width <= MAX_SIDE or not 0 < height <= MAX_SIDE or width*height > MAX_PIXELS:
        raise EditError("image_limit", "이미지는 한 변 8192픽셀, 전체 4천만 픽셀 이하여야 합니다.")


def render(root, item, data, check):
    try:
        from PIL import Image, ImageOps
    except ImportError as exc:
        raise EditError("image_dependency", "이미지 편집에 필요한 Pillow 실행 환경을 확인하세요.") from exc
    cancelled(check)
    if data["kind"] == "crop":
        raw = read_stable(safe_path(root, item["relativePath"], require_file=True), max_bytes=IMAGE_BYTES)
        if len(raw) != item["size"] or hashlib.sha256(raw).hexdigest() != item["sha256"]:
            raise EditError("source_changed", "편집 원본 파일이 변경되었습니다.")
    else:
        try:
            raw = base64.b64decode(data["pngBase64"], validate=True)
        except (ValueError, UnicodeError) as exc:
            raise EditError("invalid_capture", "영상 캡처 PNG를 읽을 수 없습니다.") from exc
        if not raw or len(raw) > IMAGE_BYTES:
            raise EditError("image_limit", "영상 캡처 PNG 크기 제한을 초과했습니다.")
    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        try:
            with Image.open(io.BytesIO(raw)) as verified:
                dimensions(verified)
                verified.verify()
            with Image.open(io.BytesIO(raw)) as opened:
                dimensions(opened)
                if data["kind"] == "capture" and (opened.format != "PNG" or getattr(opened, "n_frames", 1) != 1):
                    raise EditError("invalid_capture", "정지 PNG 프레임만 저장할 수 있습니다.")
                opened.load()
                cancelled(check)
                image = ImageOps.exif_transpose(opened)
                dimensions(image)
                if data["kind"] == "crop":
                    crop = data["crop"]
                    right, bottom = crop["x"]+crop["width"], crop["y"]+crop["height"]
                    if right > image.width or bottom > image.height:
                        raise EditError("invalid_crop", "자르기 영역이 이미지 범위를 벗어났습니다.")
                    image = image.crop((crop["x"], crop["y"], right, bottom))
                mode = "RGBA" if "A" in image.getbands() or "transparency" in image.info else "RGB"
                # A fresh pixel container strips EXIF, text chunks, profiles, and external metadata.
                normalized = Image.new(mode, image.size)
                normalized.paste(image.convert(mode))
                output = BoundedOutput()
                normalized.save(output, format="PNG")
                cancelled(check)
                return output.getvalue(), normalized.width, normalized.height
        except (Image.DecompressionBombWarning, Image.DecompressionBombError) as exc:
            raise EditError("image_limit", "이미지 픽셀 제한을 초과했습니다.") from exc
        except (OSError, SyntaxError, ValueError) as exc:
            if isinstance(exc, EditError):
                raise
            raise EditError("invalid_image", "이미지를 정상적으로 읽을 수 없습니다.") from exc


def remove_owned(path, identity):
    if path is None or identity is None:
        return
    try:
        info = path.lstat()
        if (info.st_dev, info.st_ino) == identity and not path.is_symlink():
            path.unlink()
    except FileNotFoundError:
        pass


def execute(data, *, check=lambda: False):
    validate_request(data)
    root = collection_root(Path(data["root"]))
    require_no_pending(root)
    cancelled(check)
    with CollectionLock(root) as lock:
        snapshot = view.read_snapshot(root, owned_lock=lock)
        if snapshot["snapshot"]["stateStatus"] != "read_only":
            raise EditError("edit_state_unavailable", "기존 저장 상태를 확인할 수 없습니다. 원본 자료는 보존했습니다.")
        post, item = source_file(snapshot, data)
        prepared = video_trim.prepare(root, item, data, check) if data["kind"] == "trim" else None
        raw, width, height = (None, None, None) if prepared else render(root, item, data, check)
        if stable_snapshot(view.read_snapshot(root, owned_lock=lock)) != stable_snapshot(snapshot):
            raise EditError("source_changed", "편집하는 동안 게시글 또는 파일 정보가 변경되었습니다.")
        cancelled(check)
        marker = parse_json(read_stable(safe_path(root, "media/.library.json", require_file=True), max_bytes=4096))
        library = marker.get("library_id")
        if not isinstance(library, str) or not view.UUID.fullmatch(library):
            raise EditError("invalid_library", "미디어 폴더 연결을 확인하세요.")
        media_id = uuid.uuid4().hex
        if any(attachment.get("mediaId") == media_id for post in snapshot["snapshot"]["posts"]
               for attachment in [*post["attachments"], *post.get("edits", [])]):
            raise EditError("edit_identity_conflict", "기존 파일과 겹치지 않는 편집 ID가 필요합니다.")
        extension = "mp4" if prepared else "png"
        relative = f"media/files/{library}/{media_id}.{extension}"
        final = safe_path(root, relative)
        part = safe_path(root, f"media/.partial/{media_id}.edit.{extension}")
        identity = None
        committed = False
        try:
            part.parent.mkdir(exist_ok=True)
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
            with os.fdopen(os.open(part, flags, 0o600), "wb") as output:
                info = os.fstat(output.fileno())
                identity = info.st_dev, info.st_ino
                if prepared:
                    video_trim.encode(prepared, output, check)
                else:
                    for position in range(0, len(raw), 1024*1024):
                        cancelled(check)
                        output.write(raw[position:position+1024*1024])
                output.flush()
                os.fsync(output.fileno())
            if prepared:
                verified = video_trim.verify(part, prepared, check)
                width, height = verified["width"], verified["height"]
                size, checksum = video_trim.fingerprint(root, part.relative_to(root).as_posix(), check)
            else:
                size, checksum = len(raw), hashlib.sha256(raw).hexdigest()
            lock.assert_owned()
            cancelled(check)
            if stable_snapshot(view.read_snapshot(root, owned_lock=lock)) != stable_snapshot(snapshot):
                raise EditError("source_changed", "저장하는 동안 게시글 또는 파일 정보가 변경되었습니다.")
            db_path = safe_path(root, "state/state.db", require_file=True)
            with closing(sqlite3.connect(db_path.as_uri()+"?mode=rw", uri=True, timeout=0)) as db:
                db.execute("PRAGMA trusted_schema=OFF")
                db.execute("PRAGMA synchronous=FULL")
                if db.execute("PRAGMA application_id").fetchone()[0] != view.APP_ID or db.execute("PRAGMA user_version").fetchone()[0] != view.SCHEMA_VERSION:
                    raise EditError("invalid_database", "기존 상태 DB를 확인해야 합니다.")
                meta = {key: json.loads(value) for key, value in db.execute("SELECT key,value FROM meta WHERE key IN ('root','library_id')")}
                if meta != {"root": str(root), "library_id": library}:
                    raise EditError("library_mismatch", "기존 DB와 미디어 폴더 연결이 바뀌었습니다.")
                with db:
                    db.execute("BEGIN IMMEDIATE")
                    edit_schema.ensure(db, trim=bool(prepared))
                    sequence = db.execute("SELECT coalesce(max(sequence),0)+1 FROM media_edits WHERE account=? AND post_id=?",
                        (post["account"], post["postId"])).fetchone()[0]
                    created = datetime.now(timezone.utc).isoformat()
                    columns = edit_schema.BASE_COLUMNS+(edit_schema.TRIM_COLUMNS if prepared else ())
                    values = (
                        media_id, post["account"], post["postId"], data["mediaId"], data["kind"], sequence, created,
                        relative, size, checksum, width, height,
                        json.dumps(data["crop"]) if data["kind"] == "crop" else None,
                        data["time"] if data["kind"] == "capture" else None)
                    if prepared: values += (data["start"], data["end"])
                    db.execute(f"INSERT INTO media_edits({','.join(columns)}) VALUES({','.join('?' for _ in columns)})", values)
                    lock.assert_owned()
                    cancelled(check)
                    # The temporary file is still owned, unchanged, and separate from all sources.
                    if prepared:
                        staged_size, staged_hash = video_trim.fingerprint(root, part.relative_to(root).as_posix(), check)
                    else:
                        staged = read_stable(safe_path(root, part.relative_to(root).as_posix(), require_file=True), max_bytes=IMAGE_BYTES)
                        staged_size, staged_hash = len(staged), hashlib.sha256(staged).hexdigest()
                    if staged_size != size or staged_hash != checksum:
                        raise EditError("edit_file_changed", "저장 준비 중 편집 파일이 변경되었습니다.")
                    final.parent.mkdir(exist_ok=True)
                    safe_path(root, relative)
                    # Exclusive publication, never replacing a previous original or edit.
                    os.link(part, final)
                    part.unlink()
                    sync_directory(final.parent)
                    sync_directory(part.parent)
                    cancelled(check)
                committed = True
            return {"ok": True, "mediaId": media_id}
        finally:
            remove_owned(part, identity)
            if not committed:
                remove_owned(final, identity)


def main():
    stopped = False
    monitor = None
    def stop(*_):
        nonlocal stopped
        stopped = True
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, stop)
    try:
        monitor = ParentMonitor()
        raw = sys.stdin.buffer.read(INPUT_LIMIT+1)
        if not raw or len(raw) > INPUT_LIMIT:
            raise EditError("invalid_request", "미디어 편집 요청 크기나 형식을 확인하세요.")
        result = execute(parse_json(raw), check=lambda: stopped or monitor.cancelled())
    except (EditError, SourceError, view.InputError, MonitorError, StateError, video_trim.TrimError, edit_schema.EditSchemaError) as exc:
        result = {"ok": False, "error": {"code": exc.code, "message": str(exc)}}
    except Exception:
        result = {"ok": False, "error": {"code": "edit_failed", "message": "편집 결과를 저장하지 못했습니다. 원본 파일은 보존했습니다."}}
    finally:
        if monitor is not None:
            monitor.close()
    print(json.dumps(result, ensure_ascii=False, allow_nan=False), flush=True)
    return 0 if result["ok"] else 1


if __name__ == "__main__": sys.exit(main())
