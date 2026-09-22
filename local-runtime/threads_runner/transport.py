"""Bounded, credential-free CDN GET and strict local media validation.

The caller owns durable request accounting, waits, errors and temporary cleanup.
No browser state, proxy configuration, cookies, retries or alternate URL guesses
are used. ``before_request(url, hop)`` must commit the budget before returning;
``pause(seconds)`` must persist the wait before sleeping and remain cancellable.
The request context manager is intentionally patchable for offline tests.
"""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass, field
from email.utils import parsedate_to_datetime
import hashlib
import http.client
import importlib
import ipaddress
import json
import math
import os
from pathlib import Path
import queue
import random
import re
import shutil
import socket
import ssl
import struct
import subprocess
import tempfile
import threading
import time
from typing import Callable
from urllib.parse import urlsplit
import warnings


class TransferError(Exception):
    """Safe diagnostic only: never put URLs, response bodies or OS errors here."""

    def __init__(self, code: str, message: str, retry_at: float | None = None,
                 requires_review: bool = False, status: int | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.retry_at = retry_at
        self.requires_review = requires_review
        self.status = status


@dataclass(frozen=True)
class Target:
    url: str = field(repr=False)
    hostname: str
    request_target: str = field(repr=False)


_TYPES = {
    "image": {"image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif", "application/octet-stream"},
    "video": {"video/mp4", "application/mp4", "application/octet-stream"},
}
_FORMATS = {"JPEG": ("jpg", {"image/jpeg", "image/jpg"}),
            "PNG": ("png", {"image/png"}), "WEBP": ("webp", {"image/webp"}),
            "GIF": ("gif", {"image/gif"})}
_MAX_PIXELS = 40_000_000
_ERROR_BYTES = 8192


def validate_url(url: str) -> Target:
    """Validate authority without normalizing any signed path/query bytes."""
    if (not isinstance(url, str) or len(url) > 32768 or not url
            or any(ord(c) <= 32 or ord(c) >= 127 for c in url)
            or "\\" in url or "#" in url):
        raise TransferError("unsafe_url", "CDN URL contains unsupported characters.")
    match = re.fullmatch(r"https://([^/?#]+)([^#]*)", url, flags=re.IGNORECASE)
    if not match:
        raise TransferError("unsafe_url", "Only HTTPS CDN URLs are allowed.")
    authority, raw_target = match.groups()
    try:
        parts = urlsplit(url)
        host, port = parts.hostname, parts.port
    except ValueError:
        raise TransferError("unsafe_url", "CDN URL authority is invalid.") from None
    if (not host or parts.username is not None or parts.password is not None
            or port not in (None, 443) or authority.lower() not in (host, host + ":443")
            or not re.fullmatch(r"[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?", host)
            or any(not label or len(label) > 63 or label.startswith("-") or label.endswith("-")
                   for label in host.split(".")) or len(host) > 253):
        raise TransferError("unsafe_url", "CDN URL authority is invalid.")
    if not any(host == suffix or host.endswith("." + suffix)
               for suffix in ("cdninstagram.com", "fbcdn.net")):
        raise TransferError("unsupported_host", "The media host is not an approved CDN.")
    target = raw_target if raw_target.startswith("/") else "/" + raw_target
    if target.startswith("//"):
        # http.client normalizes this form; reject rather than change a signature.
        raise TransferError("unsafe_url", "CDN paths beginning with two slashes are unsupported.")
    return Target(url, host, target)



def _redirect_target(base: Target, location: str) -> Target:
    # Resolve authority/directory only, retaining the Location path and query
    # exactly, including an empty query and encoded or literal dot segments.
    if re.match(r"[a-zA-Z][a-zA-Z0-9+.-]*:", location):
        absolute = location
    elif location.startswith("//"):
        absolute = "https:" + location
    else:
        origin = "https://" + urlsplit(base.url).netloc
        path = base.request_target.split("?", 1)[0]
        if location.startswith("/"):
            absolute = origin + location
        elif location.startswith("?"):
            absolute = origin + path + location
        else:
            absolute = origin + path.rsplit("/", 1)[0] + "/" + location
    return validate_url(absolute)


def dependencies(kind: str) -> dict:
    """Check local validators before any request; imports remain lazy."""
    if kind not in _TYPES:
        raise TransferError("unsupported_media", "Only image and video files are supported.")
    if kind == "image":
        try:
            image = importlib.import_module("PIL.Image")
            image_file = importlib.import_module("PIL.ImageFile")
        except (ImportError, OSError):
            raise TransferError("dependency_missing", "Pillow is required before image downloads.") from None
        if image_file.LOAD_TRUNCATED_IMAGES:
            raise TransferError("validator_configuration", "Pillow must reject truncated images.")
        return {"image": image}
    executable = shutil.which("ffprobe")
    if not executable:
        raise TransferError("dependency_missing", "ffprobe is required before video downloads.")
    return {"ffprobe": str(Path(executable).resolve())}


def _check(deadline: float, cancel: Callable[[], bool]) -> None:
    if cancel():
        raise TransferError("cancelled", "The download was stopped.")
    if time.monotonic() >= deadline:
        raise TransferError("timeout", "The file attempt exceeded its total time limit.")


def _resolve(host: str, timeout: float, *, deadline: float, cancel: Callable[[], bool]) -> str:
    """Bound the OS resolver, reject mixed public/private answers, pin one IP."""
    results: queue.Queue = queue.Queue(maxsize=1)

    def lookup():
        try:
            results.put(socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM, proto=socket.IPPROTO_TCP))
        except Exception:
            results.put(None)

    threading.Thread(target=lookup, daemon=True).start()
    end = min(deadline, time.monotonic() + timeout)
    while True:
        _check(deadline, cancel)
        remaining = end - time.monotonic()
        if remaining <= 0:
            raise TransferError("timeout", "CDN name resolution timed out.")
        try:
            answers = results.get(timeout=min(0.1, remaining))
            break
        except queue.Empty:
            continue
    if not answers:
        raise TransferError("transfer_failed", "CDN name resolution failed.")
    approved = []
    for family, socktype, protocol, _canon, address in answers:
        try:
            ip = ipaddress.ip_address(address[0])
        except ValueError:
            raise TransferError("unsafe_address", "CDN DNS returned an invalid address.") from None
        if (family not in (socket.AF_INET, socket.AF_INET6) or not ip.is_global
                or ip.is_multicast or ip.is_unspecified or ip.is_reserved
                or getattr(ip, "ipv4_mapped", None) is not None):
            raise TransferError("unsafe_address", "CDN DNS contains a non-public address.")
        approved.append(str(ip))
    return approved[0]


def _tls_context() -> ssl.SSLContext:
    """Use OS/OpenSSL trust locations, ignoring SSL_CERT_FILE/DIR overrides."""
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.check_hostname = True
    context.verify_mode = ssl.CERT_REQUIRED
    loaded = False
    if os.name == "nt":
        for store in ("CA", "ROOT"):
            for certificate, encoding, trust in ssl.enum_certificates(store):
                if encoding == "x509_asn" and (trust is True or ssl.Purpose.SERVER_AUTH.oid in trust):
                    context.load_verify_locations(cadata=certificate)
                    loaded = True
    paths = ssl.get_default_verify_paths()
    cafile = paths.openssl_cafile if os.path.isfile(paths.openssl_cafile) else None
    capath = paths.openssl_capath if os.path.isdir(paths.openssl_capath) else None
    if cafile or capath:
        context.load_verify_locations(cafile=cafile, capath=capath)
        loaded = True
    if not loaded:
        raise TransferError("dependency_missing", "A trusted TLS certificate store is required.")
    return context


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, target: Target, approved_ip: str, timeout: float):
        super().__init__(target.hostname, port=443, timeout=timeout, context=_tls_context())
        self._approved_ip = approved_ip
        self._active_socket = None
        self._aborted = threading.Event()

    def connect(self):
        # Construct a numeric socket address directly: no second DNS lookup.
        family = socket.AF_INET6 if ":" in self._approved_ip else socket.AF_INET
        sock = socket.socket(family, socket.SOCK_STREAM)
        self._active_socket = sock
        if self._aborted.is_set():
            sock.close()
            raise TimeoutError()
        sock.settimeout(self.timeout)
        address = (self._approved_ip, 443, 0, 0) if family == socket.AF_INET6 else (self._approved_ip, 443)
        try:
            sock.connect(address)
            wrapped = self._context.wrap_socket(sock, server_hostname=self.host, do_handshake_on_connect=False)
            self._active_socket = self.sock = wrapped
            if self._aborted.is_set():
                self.abort()
                raise TimeoutError()
            wrapped.do_handshake()
        except BaseException:
            sock.close()
            raise

    def abort(self):
        self._aborted.set()
        sock = self._active_socket
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            sock.close()


@contextmanager
def _request(target: Target, approved_ip: str, timeout: float, *,
             deadline: float, cancel: Callable[[], bool]):
    connection = _PinnedHTTPSConnection(target, approved_ip, timeout)
    stopped = threading.Event()
    response = None

    def watchdog():
        while not stopped.wait(0.1):
            if time.monotonic() >= deadline or cancel():
                connection.abort()
                return

    watcher = threading.Thread(target=watchdog, daemon=True)
    watcher.start()
    try:
        connection.request("GET", target.request_target,
                           headers={"Accept-Encoding": "identity", "Connection": "close"})
        response = connection.getresponse()
        yield response
    finally:
        stopped.set()
        if response is not None:
            response.close()
        connection.close()
        connection.abort()
        watcher.join(timeout=0.2)


def retry_after(value: str | None, *, now: float | None = None) -> float | None:
    """Return a finite absolute server minimum; malformed values stay unknown."""
    now = time.time() if now is None else now
    if not value or len(value) > 128:
        return None
    value = value.strip()
    if re.fullmatch(r"[0-9]+", value):
        if len(value) > 12:
            return None
        result = now + int(value)
        return result if math.isfinite(result) else None
    try:
        date = parsedate_to_datetime(value)
        if date.tzinfo is None:
            return None
        result = date.timestamp()
    except (ValueError, TypeError, OverflowError):
        return None
    return max(now, result) if math.isfinite(result) else None


def _read(response, limit: int, deadline: float, cancel: Callable[[], bool]) -> bytes:
    _check(deadline, cancel)
    # read1 returns after one buffered/socket read, so trickle bodies cannot
    # bypass the monotonic deadline by repeatedly resetting socket timeouts.
    chunk = response.read1(limit)
    _check(deadline, cancel)
    return chunk


def _diagnostic(response, deadline, cancel) -> bytes:
    data = bytearray()
    try:
        while len(data) < _ERROR_BYTES:
            chunk = _read(response, _ERROR_BYTES - len(data), deadline, cancel)
            if not chunk:
                break
            data.extend(chunk)
    except (OSError, http.client.HTTPException):
        pass
    return bytes(data).lower()


def _http_error(response, deadline, cancel) -> TransferError:
    status = response.status
    retry_at = retry_after(response.getheader("Retry-After")) if status in (429, 503) or 300 <= status < 400 else None
    # Preserve the first HTTP failure even if reading its diagnostic times out.
    try:
        body = _diagnostic(response, deadline, cancel)
    except TransferError:
        body = b""
    if status == 429:
        code, message = "rate_limited", "CDN request limit response; explicit review is required."
    elif b"url signature expired" in body:
        code, message = "url_expired", "CDN explicitly reported an expired URL signature."
    elif b"bad url hash" in body or b"url signature mismatch" in body:
        code, message = "signature_rejected", "CDN explicitly rejected the URL signature."
    elif status in (401, 403):
        code, message = "access_denied_unknown", "CDN denied access; the cause is not established."
    elif status in (404, 410):
        code, message = "url_unavailable", "The CDN candidate is unavailable."
    elif status == 503 and retry_at is not None:
        code, message = "server_unavailable", "CDN is unavailable until at least the server wait time."
    else:
        code, message = "transfer_failed", "CDN returned an unsuccessful HTTP response."
    return TransferError(code, message, retry_at=retry_at, requires_review=status == 429, status=status)


def _headers(response, kind: str, max_bytes: int) -> tuple[str, int | None]:
    # Ambiguous framing is rejected, including repeated Content-Length fields.
    lengths = [value for key, value in response.getheaders() if key.lower() == "content-length"]
    encodings = [value for key, value in response.getheaders() if key.lower() == "transfer-encoding"]
    types = [value for key, value in response.getheaders() if key.lower() == "content-type"]
    if len(lengths) > 1 or len(encodings) > 1 or (lengths and encodings) or len(types) != 1:
        raise TransferError("unexpected_response", "CDN returned ambiguous response headers.", status=200)
    content_type = types[0].split(";", 1)[0].strip().lower()
    if content_type not in _TYPES[kind]:
        raise TransferError("unexpected_response", "CDN returned an unsupported media Content-Type.", status=200)
    if (response.getheader("Content-Encoding", "identity").strip().lower() != "identity"
            or (encodings and encodings[0].strip().lower() != "chunked")
            or response.getheader("Content-Range") is not None):
        raise TransferError("unexpected_response", "CDN returned unsupported response encoding or range.", status=200)
    expected = None
    if lengths:
        if not re.fullmatch(r"[0-9]{1,20}", lengths[0]):
            raise TransferError("unexpected_response", "CDN returned an invalid Content-Length.", status=200)
        expected = int(lengths[0])
        if expected > max_bytes:
            raise TransferError("size_limit", "The advertised media size exceeds the file limit.", status=200)
        if expected == 0:
            raise TransferError("invalid_media", "The CDN media response is empty.", status=200)
    return content_type, expected


def _sniff(prefix: bytes, kind: str) -> None:
    if kind == "video":
        valid = len(prefix) >= 12 and prefix[4:8] == b"ftyp"
    else:
        valid = (prefix.startswith(b"\xff\xd8\xff") or prefix.startswith(b"\x89PNG\r\n\x1a\n")
                 or prefix.startswith((b"GIF87a", b"GIF89a"))
                 or (len(prefix) >= 12 and prefix[:4] == b"RIFF" and prefix[8:12] == b"WEBP"))
    if not valid:
        raise TransferError("unexpected_response", "The response body is not the selected media kind.", status=200)


def _image_metadata(path: Path, dep: dict, content_type: str, deadline, cancel) -> dict:
    image = dep["image"]
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error")
            with image.open(path) as media:
                format_name, dimensions = media.format, media.size
                if format_name not in _FORMATS:
                    raise ValueError()
                width, height = dimensions
                if width <= 0 or height <= 0 or width > 32768 or height > 32768 or width * height > _MAX_PIXELS:
                    raise ValueError()
                media.verify()
            with image.open(path) as media:
                frames = getattr(media, "n_frames", 1)
                if frames > 256 or width * height * frames > _MAX_PIXELS:
                    raise ValueError()
                for index in range(frames):
                    _check(deadline, cancel)
                    media.seek(index)
                    media.load()
            extension, allowed = _FORMATS[format_name]
            if content_type != "application/octet-stream" and content_type not in allowed:
                raise ValueError()
    except TransferError:
        raise
    except Exception:
        raise TransferError("invalid_media", "The image could not be fully validated.", status=200) from None
    _check(deadline, cancel)
    return {"extension": extension, "width": width, "height": height}


def _mp4_boxes(path: Path, deadline, cancel) -> None:
    total = path.stat().st_size
    seen = set()
    offset = 0
    with path.open("rb") as source:
        while offset < total:
            _check(deadline, cancel)
            source.seek(offset)
            header = source.read(16)
            if len(header) < 8:
                raise TransferError("invalid_media", "The MP4 box header is truncated.", status=200)
            size, kind = struct.unpack(">I4s", header[:8])
            header_length = 8
            if size == 1:
                if len(header) < 16:
                    raise TransferError("invalid_media", "The MP4 extended box header is truncated.", status=200)
                size = struct.unpack(">Q", header[8:16])[0]
                header_length = 16
            elif size == 0:
                size = total - offset
            if size < header_length or offset + size > total:
                raise TransferError("invalid_media", "The MP4 box extends beyond the complete file.", status=200)
            if kind in (b"ftyp", b"moov", b"mdat"):
                if size <= header_length:
                    raise TransferError("invalid_media", "A required MP4 box is empty.", status=200)
                seen.add(kind)
            offset += size
    if seen != {b"ftyp", b"moov", b"mdat"}:
        raise TransferError("invalid_media", "The MP4 lacks required file, metadata or media boxes.", status=200)


def _video_metadata(path: Path, dep: dict, deadline, cancel) -> dict:
    _mp4_boxes(path, deadline, cancel)
    _check(deadline, cancel)
    command = [dep["ffprobe"], "-v", "error", "-protocol_whitelist", "file", "-format_whitelist", "mov",
               "-enable_drefs", "0", "-use_absolute_path", "0", "-i", str(path.resolve()),
               "-count_packets", "-show_entries", "stream=codec_type,width,height,nb_read_packets:format=format_name",
               "-of", "json"]
    try:
        with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as error:
            process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=output, stderr=error,
                                       env={}, shell=False)
            try:
                validation_end = min(deadline, time.monotonic() + 60)
                while process.poll() is None:
                    _check(validation_end, cancel)
                    try:
                        process.wait(timeout=min(0.1, max(0.001, validation_end - time.monotonic())))
                    except subprocess.TimeoutExpired:
                        continue
            finally:
                if process.poll() is None:
                    process.kill()
                process.wait()
            if process.returncode or output.tell() > 65536 or error.tell() > 0:
                raise ValueError()
            output.seek(0)
            metadata = json.loads(output.read(65537))
        streams = [stream for stream in metadata.get("streams", []) if stream.get("codec_type") == "video"]
        if not streams or "mp4" not in metadata.get("format", {}).get("format_name", "").split(","):
            raise ValueError()
        stream = streams[0]
        width, height = int(stream["width"]), int(stream["height"])
        if width <= 0 or height <= 0 or width * height > _MAX_PIXELS or int(stream.get("nb_read_packets", 0)) <= 0:
            raise ValueError()
    except TransferError:
        raise
    except Exception:
        raise TransferError("invalid_media", "The MP4 container or video packets failed validation.", status=200) from None
    _check(deadline, cancel)
    return {"extension": "mp4", "width": width, "height": height}


def download(url: str, dest: Path, kind: str, *, before_request: Callable[[str, int], None],
             pause: Callable[[float], None], max_redirects: int = 0, timeout_seconds: float = 30,
             total_timeout_seconds: float = 600, max_bytes: int = 1024**3,
             cancel: Callable[[], bool] = lambda: False,
             progress: Callable[[str, int, int | None], None] = lambda *_: None) -> dict:
    """Stream one candidate into a new exclusive .part; never remove failed files.

    Validation proves image decoding or MP4 container/packet readability, not a
    complete video frame decode. All redirects consume an additional request.
    """
    if (not isinstance(max_redirects, int) or isinstance(max_redirects, bool) or not 0 <= max_redirects <= 3
            or not isinstance(max_bytes, int) or isinstance(max_bytes, bool) or max_bytes <= 0
            or not isinstance(timeout_seconds, (int, float)) or not math.isfinite(timeout_seconds) or timeout_seconds <= 0
            or not isinstance(total_timeout_seconds, (int, float)) or not math.isfinite(total_timeout_seconds)
            or total_timeout_seconds <= 0):
        raise TransferError("invalid_policy", "The transfer limits are invalid.")
    dep = dependencies(kind)
    target = validate_url(url)
    dest = Path(dest)
    if dest.suffix != ".part":
        raise TransferError("invalid_destination", "Downloads require a new .part destination.")
    deadline = time.monotonic() + total_timeout_seconds
    _check(deadline, cancel)
    try:
        with dest.open("xb") as output:
            for hop in range(max_redirects + 1):
                _check(deadline, cancel)
                approved_ip = _resolve(target.hostname, timeout_seconds, deadline=deadline, cancel=cancel)
                _check(deadline, cancel)
                before_request(target.url, hop)
                _check(deadline, cancel)
                redirect = None
                server_wait = None
                with _request(target, approved_ip, min(timeout_seconds, deadline - time.monotonic()),
                              deadline=deadline, cancel=cancel) as response:
                    if response.status in (301, 302, 303, 307, 308):
                        server_wait = retry_after(response.getheader("Retry-After"))
                        if hop >= max_redirects:
                            raise TransferError("redirect_limit", "The CDN redirect limit was reached.",
                                                retry_at=server_wait, status=response.status)
                        location = response.getheader("Location")
                        if not location or any(ord(c) <= 32 or ord(c) >= 127 for c in location) or "#" in location or "\\" in location:
                            raise TransferError("unsafe_redirect", "CDN returned an invalid redirect destination.",
                                                retry_at=server_wait, status=response.status)
                        try:
                            redirect = _redirect_target(target, location)
                        except TransferError as error:
                            raise TransferError(error.code, error.message, retry_at=server_wait,
                                                status=response.status) from None
                    elif response.status != 200:
                        raise _http_error(response, deadline, cancel)
                    else:
                        content_type, expected = _headers(response, kind, max_bytes)
                        digest, size, prefix = hashlib.sha256(), 0, bytearray()
                        progress("downloading", 0, expected)
                        while True:
                            read_limit = 65536 if len(prefix) >= 12 else _ERROR_BYTES
                            chunk = _read(response, min(read_limit, max_bytes - size + 1), deadline, cancel)
                            if not chunk:
                                break
                            size += len(chunk)
                            if size > max_bytes:
                                raise TransferError("size_limit", "The received media exceeds the file limit.", status=200)
                            if len(prefix) < 12:
                                prefix.extend(chunk[:12 - len(prefix)])
                                if len(prefix) >= 12:
                                    _sniff(bytes(prefix), kind)
                            output.write(chunk)
                            digest.update(chunk)
                            progress("downloading", size, expected)
                        if expected is not None and size != expected:
                            raise TransferError("length_mismatch", "Received bytes do not match Content-Length.", status=200)
                        if not size:
                            raise TransferError("invalid_media", "The CDN media response is empty.", status=200)
                        _sniff(bytes(prefix), kind)
                        output.flush()
                        os.fsync(output.fileno())
                        _check(deadline, cancel)
                        progress("validating", size, expected)
                        metadata = (_image_metadata(dest, dep, content_type, deadline, cancel) if kind == "image"
                                    else _video_metadata(dest, dep, deadline, cancel))
                        return {"size": size, "sha256": digest.hexdigest(), "content_type": content_type, **metadata}
                # The previous response/socket are closed before durable waiting.
                wait = max(random.uniform(3, 10), max(0, (server_wait or 0) - time.time()))
                if time.monotonic() + wait >= deadline:
                    raise TransferError("timeout", "The server redirect wait exceeds the attempt time limit.", retry_at=server_wait)
                pause(wait)
                _check(deadline, cancel)
                target = redirect
    except TransferError:
        raise
    except FileExistsError:
        raise TransferError("destination_exists", "The temporary destination already exists.") from None
    except (TimeoutError, socket.timeout):
        _check(deadline, cancel)
        raise TransferError("timeout", "CDN transfer timed out.") from None
    except http.client.IncompleteRead:
        raise TransferError("length_mismatch", "The CDN response ended before its declared length.") from None
    except (ssl.SSLError, http.client.HTTPException):
        _check(deadline, cancel)
        raise TransferError("transfer_failed", "The verified HTTPS transfer failed.") from None
    except OSError:
        _check(deadline, cancel)
        raise TransferError("transfer_failed", "The network or temporary file operation failed.") from None
    raise TransferError("transfer_failed", "The media transfer did not complete.")
