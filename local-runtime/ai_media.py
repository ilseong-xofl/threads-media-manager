"""Read verified, versioned AI images without importing them into the media DB."""
from __future__ import annotations

from datetime import datetime, timedelta
import hashlib
import re

from threads_source.files import SourceError, parse_json, read_stable, safe_path

TOKEN = re.compile(r"[0-9a-f]{32}")
HASH = re.compile(r"[0-9a-f]{64}")
AI_PATH = re.compile(r"ai-drafts/([0-9a-f]{32})/([0-9a-f]{32})/(0[12]\.(png|jpg|webp))")
MAX_IMAGE_BYTES = 16 * 1024**2


def post_folder(post_key):
    return hashlib.sha256(post_key.encode("utf-8")).hexdigest()[:32]


def media_id(folder, generation, filename):
    return hashlib.sha256(f"ai:{folder}:{generation}:{filename}".encode()).hexdigest()[:32]


def file_extension(relative, identifier):
    match = AI_PATH.fullmatch(relative or "")
    if not match or media_id(match[1], match[2], match[3]) != identifier:
        return None
    return match[4]


def file_record(root, relative, identifier, digest):
    extension = file_extension(relative, identifier)
    if not extension or not isinstance(digest, str) or not HASH.fullmatch(digest):
        raise SourceError("invalid_ai_media", "AI 생성 이미지의 연결 정보를 확인하세요.")
    raw = read_stable(safe_path(root, relative, require_file=True), max_bytes=MAX_IMAGE_BYTES)
    valid_header = ((extension == "png" and raw.startswith(b"\x89PNG\r\n\x1a\n")) or
                    (extension == "jpg" and raw.startswith(b"\xff\xd8\xff")) or
                    (extension == "webp" and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP"))
    if not raw or not valid_header or hashlib.sha256(raw).hexdigest() != digest:
        raise SourceError("ai_media_changed", "AI 생성 이미지가 누락되거나 변경되었습니다.")
    return {"id": identifier, "relativePath": relative, "size": len(raw), "sha256": digest, "kind": "image"}


def created_at(value):
    if (not isinstance(value, str) or len(value) > 64 or
            not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)", value)):
        raise ValueError("Invalid creation date")
    parsed = datetime.fromisoformat(value)
    if parsed.utcoffset() != timedelta(0):
        raise ValueError("Invalid timezone")
    return parsed


def generation_manifest(root, post_key, generation, original_ids):
    folder = post_folder(post_key)
    relative = f"ai-drafts/{folder}/{generation}/draft.json"
    raw = read_stable(safe_path(root, relative, require_file=True), max_bytes=128 * 1024)
    data = parse_json(raw)
    if (not isinstance(data, dict) or data.get("id") != generation or data.get("postKey") != post_key or
            data.get("aiGenerated") is not True or data.get("status") != "review" or
            not isinstance(data.get("mediaIds"), list) or not 1 <= len(data["mediaIds"]) <= 20 or
            any(not isinstance(value, str) or not TOKEN.fullmatch(value) for value in data["mediaIds"]) or
            len(set(data["mediaIds"])) != len(data["mediaIds"]) or
            data["mediaIds"] != original_ids or type(data.get("sourceImageCount")) is not int or
            data["sourceImageCount"] != len(data["mediaIds"]) or
            not isinstance(data.get("files"), list) or len(data["files"]) != min(2, len(data["mediaIds"])) or
            any(not isinstance(name, str) or not re.fullmatch(rf"0{index}\.(png|jpg|webp)", name)
                for index, name in enumerate(data["files"], 1)) or
            not isinstance(data.get("imageHashes"), list) or len(data["imageHashes"]) != len(data["files"]) or
            any(not isinstance(value, str) or not HASH.fullmatch(value) for value in data["imageHashes"])):
        raise ValueError("Invalid AI manifest")
    created_at(data.get("createdAt"))
    return data, relative, raw


def read_post(root, post_key, original_ids):
    """All complete generations, oldest first. Bad assets remain unavailable entries."""
    items, files, warnings = [], [], []
    folder = post_folder(post_key)
    parent = safe_path(root, f"ai-drafts/{folder}")
    if not parent.exists():
        return items, files, warnings
    versions = sorted(path.name for path in parent.iterdir() if TOKEN.fullmatch(path.name))
    if len(versions) > 1000:
        raise SourceError("ai_media_limit", "AI 생성 이력이 너무 많아 확인할 수 없습니다.")
    for generation in versions:
        try:
            data, manifest_path, before = generation_manifest(root, post_key, generation, original_ids)
            version_items, version_files = [], []
            for index, (filename, digest) in enumerate(zip(data["files"], data["imageHashes"]), 1):
                identifier = media_id(folder, generation, filename)
                relative = f"ai-drafts/{folder}/{generation}/{filename}"
                item = {"ordinal": index, "kind": "image", "addressStatus": "generated", "observedAt": None,
                        "status": "saved", "reason": None, "mediaId": identifier,
                        "localUrl": f"threads-media://file/{identifier}", "aiGenerated": True,
                        "generationId": generation, "createdAt": data["createdAt"]}
                try:
                    version_files.append(file_record(root, relative, identifier, digest))
                except (SourceError, OSError, ValueError):
                    item.update(status="unavailable", reason="ai_media_unavailable", localUrl=None)
                    warnings.append({"code": "ai_media_unavailable", "message": "AI 생성 이미지가 누락되거나 변경되었습니다. 기존 등록 선택은 보존됩니다."})
                version_items.append(item)
            if read_stable(safe_path(root, manifest_path, require_file=True), max_bytes=128 * 1024) != before:
                raise SourceError("ai_manifest_changed", "읽는 동안 AI 생성 정보가 변경되었습니다.")
            items.extend(version_items)
            files.extend(version_files)
        except (SourceError, OSError, ValueError, TypeError, KeyError):
            warnings.append({"code": "ai_media_unavailable", "message": "저장된 AI 생성 정보를 확인하지 못했습니다. 기존 자료와 등록 선택은 보존됩니다."})
    after = sorted(path.name for path in parent.iterdir() if TOKEN.fullmatch(path.name))
    if after != versions:
        raise SourceError("ai_media_changed", "읽는 동안 AI 생성 이력이 변경되었습니다. 다시 확인하세요.")
    items.sort(key=lambda item: (created_at(item["createdAt"]), item["generationId"], item["ordinal"]))
    return items, files, warnings
