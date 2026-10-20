#!/usr/bin/env python3
"""Convert one prepared WebP upload copy to PNG. Electron's nativeImage decodes only PNG and JPEG."""
from __future__ import annotations

import json
from pathlib import Path
import stat
import sys
import warnings

from PIL import Image, ImageOps

INPUT_LIMIT = 16 * 1024
SOURCE_BYTES = 32 * 1024 * 1024
MAX_PIXELS = 40_000_000
RETRY = "이미지를 JPG·PNG로 바꿔 다시 선택하세요."


class ConvertError(ValueError):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


def request_paths(data):
    if not isinstance(data, dict) or set(data) != {"source", "destination"}:
        raise ConvertError("convert_request", "이미지 변환 요청을 확인하세요.")
    source, destination = data["source"], data["destination"]
    if (not isinstance(source, str) or not isinstance(destination, str) or
            "\x00" in source or "\x00" in destination):
        raise ConvertError("convert_request", "이미지 변환 요청을 확인하세요.")
    source, destination = Path(source), Path(destination)
    if (not source.is_absolute() or not destination.is_absolute() or source.suffix != ".webp" or
            destination.suffix != ".png" or source.parent != destination.parent):
        raise ConvertError("convert_request", "이미지 변환 요청을 확인하세요.")
    info = source.lstat()
    if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= SOURCE_BYTES:
        raise ConvertError("convert_request", "변환할 WebP 파일을 확인하세요.")
    return source, destination


def convert_request(data):
    source, destination = request_paths(data)
    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        try:
            with Image.open(source) as opened:
                if opened.format != "WEBP":
                    raise ConvertError("convert_invalid_image", f"WebP 이미지를 읽을 수 없습니다. {RETRY}")
                if opened.width * opened.height > MAX_PIXELS:
                    raise ConvertError("convert_image_limit", "이미지는 전체 4천만 픽셀 이하여야 합니다.")
                opened.load()
                image = ImageOps.exif_transpose(opened)
                mode = "RGBA" if "A" in image.getbands() or "transparency" in image.info else "RGB"
                # A fresh pixel container strips EXIF, text chunks, profiles, and external metadata.
                normalized = Image.new(mode, image.size)
                normalized.paste(image.convert(mode))
        except (Image.DecompressionBombWarning, Image.DecompressionBombError) as exc:
            raise ConvertError("convert_image_limit", "이미지는 전체 4천만 픽셀 이하여야 합니다.") from exc
        except (OSError, SyntaxError, ValueError) as exc:
            if isinstance(exc, ConvertError):
                raise
            raise ConvertError("convert_invalid_image", f"WebP 이미지를 읽을 수 없습니다. {RETRY}") from exc
    with destination.open("xb") as output:
        normalized.save(output, format="PNG")


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        raw = sys.stdin.buffer.read(INPUT_LIMIT + 1)
        if not raw or len(raw) > INPUT_LIMIT:
            raise ConvertError("convert_request", "이미지 변환 요청을 확인하세요.")
        convert_request(json.loads(raw))
        result = {"ok": True}
    except ConvertError as exc:
        result = {"ok": False, "error": {"code": exc.code, "message": str(exc)}}
    except Exception:
        result = {"ok": False, "error": {"code": "convert_failed",
                                         "message": f"WebP 이미지를 PNG로 변환하지 못했습니다. {RETRY}"}}
    print(json.dumps(result, ensure_ascii=False), flush=True)
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
