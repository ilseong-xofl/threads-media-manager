"""Bounded local ffmpeg editing. All subprocesses are reaped before returning."""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

from threads_source.files import safe_path

PROBE_TIMEOUT = 30
ENCODE_TIMEOUT = 1800
MAX_OUTPUT_BYTES = 8 * 1024**3
DIAGNOSTIC_LIMIT = 1024 * 1024


class TrimError(ValueError):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


def cancelled(check):
    if check(): raise TrimError("cancelled", "영상 구간 저장을 취소했습니다. 원본은 보존했습니다.")


def dependencies():
    result = {}
    for name in ("ffmpeg", "ffprobe"):
        value = shutil.which(name)
        if not value:
            raise TrimError("video_dependency", "영상 자르기에 필요한 ffmpeg·ffprobe 실행 환경을 확인하세요.")
        result[name] = str(Path(value).resolve())
    return result


def process_environment():
    if os.name == "nt":
        system_root = os.environ.get("SystemRoot") or os.environ.get("SYSTEMROOT")
        if system_root: return {"SystemRoot": system_root}
    return {}


def run(command, output, *, timeout, check, maximum=DIAGNOSTIC_LIMIT):
    cancelled(check)
    with tempfile.TemporaryFile() as error:
        process = None
        try:
            process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=output,
                                       stderr=error, shell=False, env=process_environment())
            deadline = time.monotonic()+timeout
            while True:
                cancelled(check)
                if time.monotonic() >= deadline:
                    raise TrimError("video_timeout", "영상 처리 제한 시간을 초과했습니다. 원본은 보존했습니다.")
                if os.fstat(output.fileno()).st_size > maximum or os.fstat(error.fileno()).st_size > DIAGNOSTIC_LIMIT:
                    raise TrimError("video_limit", "영상 처리 결과의 크기 제한을 초과했습니다.")
                if process.poll() is not None: break
                try: process.wait(timeout=0.1)
                except subprocess.TimeoutExpired: pass
            if process.returncode != 0 or os.fstat(error.fileno()).st_size:
                raise TrimError("invalid_video", "영상을 읽거나 구간을 저장하지 못했습니다. 원본은 보존했습니다.")
        except OSError as exc:
            raise TrimError("video_dependency", "영상 처리 프로그램을 실행할 수 없습니다.") from exc
        finally:
            if process is not None:
                if process.poll() is None:
                    try: process.terminate()
                    except ProcessLookupError: pass
                    try: process.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        try: process.kill()
                        except ProcessLookupError: pass
                process.wait()


def probe(path, dep, check):
    command = [dep["ffprobe"], "-v", "error", "-protocol_whitelist", "file", "-format_whitelist", "mov,matroska,webm",
        "-i", str(path), "-show_entries", "stream=codec_type,codec_name,width,height,duration,avg_frame_rate,sample_rate:format=duration,format_name",
        "-of", "json"]
    with tempfile.TemporaryFile() as output:
        run(command, output, timeout=PROBE_TIMEOUT, check=check)
        output.seek(0)
        try:
            value = json.loads(output.read(DIAGNOSTIC_LIMIT+1))
            videos = [stream for stream in value["streams"] if stream.get("codec_type") == "video"]
            audios = [stream for stream in value["streams"] if stream.get("codec_type") == "audio"]
            video = videos[0]
            duration = float(video.get("duration", value["format"].get("duration", "nan")))
            container_duration = float(value["format"].get("duration", "nan"))
            width, height = int(video["width"]), int(video["height"])
            rate = video.get("avg_frame_rate", "0/1").split("/")
            fps = float(rate[0])/float(rate[1]) if len(rate) == 2 and float(rate[1]) else 0
            if (not math.isfinite(duration) or duration <= 0 or not math.isfinite(container_duration) or
                    container_duration <= 0 or width < 1 or height < 1):
                raise ValueError()
            # HTMLVideoElement.duration uses the container duration. Fragmented AAC
            # can add one encoder packet after the final video frame. Accept only
            # that measured tail; unrelated/longer audio must not extend selection.
            padding = 0
            if audios and all(stream.get("codec_name") == "aac" for stream in audios):
                rates = [int(stream.get("sample_rate", 0)) for stream in audios]
                if all(rate >= 8000 for rate in rates): padding = max(1024/rate for rate in rates)
            tail = container_duration-duration
            selection_end = container_duration if 0 < tail <= padding+1e-4 and padding else duration
            return {"duration": duration, "containerDuration": container_duration, "selectionEnd": selection_end,
                "width": width, "height": height, "fps": fps,
                "videoCodec": video.get("codec_name"), "audioCodecs": [stream.get("codec_name") for stream in audios],
                "format": value["format"].get("format_name", "")}
        except (KeyError, IndexError, TypeError, ValueError) as exc:
            raise TrimError("invalid_video", "영상 길이와 화면 정보를 확인할 수 없습니다.") from exc


def prepare(root, item, data, check):
    dep = dependencies()
    path = safe_path(root, item["relativePath"], require_file=True)
    source = probe(path, dep, check)
    if data["start"] >= source["duration"] or data["end"] > source["selectionEnd"]+1e-6:
        raise TrimError("invalid_trim", "시작·종료 시간을 영상 길이 안에서 지정하세요.")
    return {"dep": dep, "path": path, "source": source, "start": data["start"],
            "duration": min(data["end"], source["duration"])-data["start"]}


def encode(prepared, output, check):
    command = [prepared["dep"]["ffmpeg"], "-v", "error", "-nostdin", "-protocol_whitelist", "file,pipe",
        "-format_whitelist", "mov,matroska,webm", "-ss", format(prepared["start"], ".12g"), "-i", str(prepared["path"]),
        "-t", format(prepared["duration"], ".12g"), "-map", "0:v:0", "-map", "0:a:0?",
        "-map_metadata", "-1", "-map_chapters", "-1", "-sn", "-dn",
        "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
        "-pix_fmt", "yuv420p", "-bf", "0", "-c:a", "aac", "-b:a", "192k",
        # Pipe output writes only our already-open exclusive file descriptor on both OSes.
        "-movflags", "+frag_keyframe+delay_moov+default_base_moof", "-f", "mp4", "pipe:1"]
    run(command, output, timeout=ENCODE_TIMEOUT, check=check, maximum=MAX_OUTPUT_BYTES)


def verify(path, prepared, check):
    result = probe(path, prepared["dep"], check)
    tolerance = max(0.15, 2/max(prepared["source"]["fps"], 1))
    if (result["videoCodec"] != "h264" or "mp4" not in result["format"].split(",") or
            abs(result["duration"]-prepared["duration"]) > tolerance or
            bool(result["audioCodecs"]) != bool(prepared["source"]["audioCodecs"]) or
            any(codec != "aac" for codec in result["audioCodecs"])):
        raise TrimError("invalid_video", "저장된 영상의 구간·코덱·오디오 검증에 실패했습니다.")
    return result


def fingerprint(root, relative, check, maximum=MAX_OUTPUT_BYTES):
    path = safe_path(root, relative, require_file=True)
    before = path.stat()
    if before.st_size <= 0 or before.st_size > maximum:
        raise TrimError("video_limit", "편집 결과의 파일 크기를 확인하세요.")
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    checksum = hashlib.sha256()
    stamp = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
    with os.fdopen(os.open(path, flags), "rb") as stream:
        if stamp(os.fstat(stream.fileno())) != stamp(before):
            raise TrimError("edit_file_changed", "편집 파일이 변경되었습니다.")
        for block in iter(lambda: stream.read(1024*1024), b""):
            cancelled(check)
            checksum.update(block)
        if stamp(os.fstat(stream.fileno())) != stamp(before):
            raise TrimError("edit_file_changed", "편집 파일이 변경되었습니다.")
    safe_path(root, relative, require_file=True)
    if stamp(path.stat()) != stamp(before): raise TrimError("edit_file_changed", "편집 파일이 변경되었습니다.")
    return before.st_size, checksum.hexdigest()
