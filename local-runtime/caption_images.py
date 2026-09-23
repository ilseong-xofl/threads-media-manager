"""Prepare bounded, metadata-free caption inputs without writing to the collection."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import signal
import stat
import sys
import tempfile
import warnings

sys.path.insert(0, str(Path(__file__).resolve().parent))
import collection_view as view
from PIL import Image, ImageOps

MAX_SELECTION = 100
MAX_IMAGES = 20
MAX_IMAGE_BYTES = 2 * 1024**2
MAX_TOTAL_BYTES = 32 * 1024**2
MAX_SOURCE_BYTES = 2 * 1024**3
MAX_PIXELS = 40_000_000
_cancelled = False


class PrepareError(ValueError):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


def check():
    if _cancelled:
        raise PrepareError("caption_cancelled", "캡션 생성을 취소했습니다.")
    return False


def normalize_image(source, destination):
    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        with Image.open(source) as image:
            if image.width * image.height > MAX_PIXELS:
                raise PrepareError("caption_image_limit", "이미지의 픽셀 수가 생성 준비 한도를 초과합니다.")
            image = ImageOps.exif_transpose(image)
            image.thumbnail((1536, 1536), Image.Resampling.LANCZOS)
            rgba = image.convert("RGBA")
            clean = Image.new("RGB", rgba.size, "white")
            clean.paste(rgba, mask=rgba.getchannel("A"))
            with destination.open("xb") as output:
                clean.save(output, format="JPEG", quality=85, optimize=True)
    if not 0 < destination.stat().st_size <= MAX_IMAGE_BYTES:
        raise PrepareError("caption_image_limit", "이미지 준비 결과의 크기 한도를 초과했습니다.")


def output_directory(raw, token, root):
    if not isinstance(raw, str) or not isinstance(token, str) or not re.fullmatch(r"[0-9a-f]{32}", token):
        raise PrepareError("caption_input", "캡션 생성 입력을 확인하세요.")
    path = Path(raw)
    if not path.is_absolute() or path.is_symlink() or path.resolve() != path:
        raise PrepareError("caption_input", "임시 이미지 폴더를 확인할 수 없습니다.")
    info = path.stat()
    if (not stat.S_ISDIR(info.st_mode) or path.parent != Path(tempfile.gettempdir()).resolve()
            or not path.name.startswith("tmm-caption-") or path == root or root in path.parents
            or (hasattr(os, "getuid") and info.st_uid != os.getuid())):
        raise PrepareError("caption_input", "임시 이미지 폴더를 확인할 수 없습니다.")
    marker = path / ".owner"
    if set(p.name for p in path.iterdir()) != {".owner"} or marker.is_symlink() or marker.stat().st_nlink != 1 or marker.read_text() != token:
        raise PrepareError("caption_input", "임시 이미지 폴더의 소유권을 확인할 수 없습니다.")
    return path


def prepare(data, *, include_ai=False):
    if not isinstance(data, dict):
        raise PrepareError("caption_input", "캡션 생성 입력을 확인하세요.")
    ids, key = data.get("mediaIds"), data.get("postKey")
    if (not isinstance(ids, list) or not 1 <= len(ids) <= MAX_SELECTION or
            any(not isinstance(value, str) or not view.UUID.fullmatch(value) for value in ids)
            or len(set(ids)) != len(ids) or not isinstance(key, str) or not 0 < len(key) <= 512):
        raise PrepareError("caption_input", "캡션 생성에는 저장된 미디어를 1개부터 100개까지 선택하세요.")
    root = view.collection_root(Path(data.get("root", "")))
    output = output_directory(data.get("output"), data.get("token"), root)
    check()
    snapshot = view.read_snapshot(root, include_ai=include_ai)
    if any(w["code"] == "deletion_recovery_required" for w in snapshot["snapshot"]["warnings"]):
        raise PrepareError("deletion_recovery_required", "중단된 삭제 작업을 먼저 복구하세요.")
    post = next((p for p in snapshot["snapshot"]["posts"] if p["key"] == key), None)
    if post is None:
        raise PrepareError("caption_source", "게시글을 찾을 수 없습니다. 목록을 새로고침하세요.")
    media = {a["mediaId"]: a for a in post["attachments"] + post.get("edits", []) + post.get("aiImages", []) if a["status"] == "saved" and a.get("localUrl")}
    if data.get("originalOnly") is True:
        originals = [a for a in post["attachments"] if a["kind"] == "image"]
        if ids != [a["mediaId"] for a in originals] or any(a.get("editType") or a["status"] != "saved" for a in originals):
            raise PrepareError("caption_source", "원본 이미지 전체를 순서대로 전달해야 합니다.")
    registry = {f["id"]: f for f in snapshot["files"]}
    if any(media_id not in media or media_id not in registry for media_id in ids):
        raise PrepareError("caption_source", "선택한 미디어의 저장 상태를 확인하세요.")
    if any(media[media_id]["kind"] != registry[media_id]["kind"] for media_id in ids):
        raise PrepareError("caption_source", "선택한 미디어의 저장 종류를 확인하세요.")
    # Validate the entire selection before filtering so a foreign video cannot
    # bypass the ownership boundary. Only saved images become model inputs.
    image_ids = [media_id for media_id in ids if media[media_id]["kind"] == "image"]
    if not image_ids:
        raise PrepareError("caption_images_required", "AI 캡션 생성에는 이미지를 한 개 이상 선택하세요.")
    if len(image_ids) > MAX_IMAGES:
        raise PrepareError("caption_image_limit", "AI 캡션 생성에는 이미지를 최대 20개까지 선택하세요.")
    caption = post["caption"]
    if len(caption.encode("utf-8")) > 128 * 1024:
        raise PrepareError("caption_input", "원본 캡션이 생성 입력 한도를 초과합니다.")
    total, images = 0, []
    for index, media_id in enumerate(image_ids):
        check()
        item = registry[media_id]
        if item["size"] > MAX_SOURCE_BYTES:
            raise PrepareError("caption_image_limit", "선택한 파일이 생성 준비 한도를 초과합니다.")
        row = {"final_rel": item["relativePath"], "media_id": media_id,
               "size": item["size"], "sha256": item["sha256"], "kind": item["kind"]}
        view.local_file(root, row, include_ai=include_ai)
        source = view.safe_path(root, item["relativePath"], require_file=True)
        filename = f"image-{index + 1:02d}.jpg"
        destination = output / filename
        normalize_image(source, destination)
        check()
        view.local_file(root, row, include_ai=include_ai)
        total += destination.stat().st_size
        if total > MAX_TOTAL_BYTES:
            raise PrepareError("caption_image_limit", "선택한 이미지의 총 크기가 생성 한도를 초과합니다.")
        images.append(filename)
    view.idle(root)
    return {"ok": True, "caption": caption, "images": images}


def main(argv=()):
    parser = argparse.ArgumentParser()
    parser.add_argument("--include-ai", action="store_true")
    args = parser.parse_args(argv)
    global _cancelled
    def stop(_signal, _frame):
        global _cancelled
        _cancelled = True
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        raw = sys.stdin.buffer.read(64 * 1024 + 1)
        if len(raw) > 64 * 1024: raise ValueError("input limit")
        result = prepare(json.loads(raw), include_ai=args.include_ai)
    except (PrepareError, view.SourceError) as exc:
        result = {"ok": False, "error": {"code": exc.code, "message": str(exc)}}
    except Exception:
        result = {"ok": False, "error": {"code": "caption_prepare", "message": "선택한 미디어를 준비하지 못했습니다. 저장 파일을 확인하세요."}}
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main(sys.argv[1:])
