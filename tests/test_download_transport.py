"""Offline security, framing, deadline and local-validator transport tests."""
from contextlib import contextmanager
from email.utils import formatdate
import hashlib
import importlib.util
import io
import os
from pathlib import Path
import shutil
import socket
import ssl
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import zlib

SCRIPT = Path(__file__).resolve().parents[1] / "local-runtime/threads_runner/transport.py"
SPEC = importlib.util.spec_from_file_location("download_transport_tests_module", SCRIPT)
t = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = t
SPEC.loader.exec_module(t)
URL = "https://scontent.example.cdninstagram.com/a%2Fb.png?sig=A%2bB%2FC&v=1&v=2&empty="


def png_bytes():
    def chunk(kind, body):
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 2, 1, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(b"\x00\xff\x00\x00\x00\xff\x00")) + chunk(b"IEND", b""))


class Response:
    def __init__(self, status=200, body=None, headers=None, chunk_size=None):
        self.status = status
        self.body = io.BytesIO(png_bytes() if body is None else body)
        self.headers = list(headers.items()) if isinstance(headers, dict) else headers
        if self.headers is None:
            self.headers = [("Content-Type", "image/png"), ("Content-Length", str(len(self.body.getvalue()))) ]
        self.chunk_size = chunk_size
        self.read_sizes = []
        self.closed = False

    def getheaders(self):
        return self.headers

    def getheader(self, key, default=None):
        values = [value for name, value in self.headers if name.lower() == key.lower()]
        return ", ".join(values) if values else default

    def read1(self, count):
        self.read_sizes.append(count)
        return self.body.read(min(count, self.chunk_size or count))

    def close(self):
        self.closed = True


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.dest = Path(self.directory.name) / "attempt.part"
        self.responses = []
        self.requests = []
        self.events = []
        self.dependency = mock.patch.object(t, "dependencies", return_value={"image": object()})
        self.dependency.start()
        self.addCleanup(self.dependency.stop)
        self.resolver = mock.patch.object(t, "_resolve", return_value="8.8.8.8")
        self.resolve = self.resolver.start()
        self.addCleanup(self.resolver.stop)
        self.validator = mock.patch.object(t, "_image_metadata", return_value={"extension": "png", "width": 2, "height": 1})
        self.validate = self.validator.start()
        self.addCleanup(self.validator.stop)

        @contextmanager
        def request(target, approved_ip, timeout, **kwargs):
            number = len(self.requests)
            self.requests.append((target, approved_ip, timeout, kwargs))
            self.events.append(("request", number))
            response = self.responses.pop(0)
            try:
                yield response
            finally:
                response.close()
                self.events.append(("close", number))

        patcher = mock.patch.object(t, "_request", side_effect=request)
        self.mock_request = patcher.start()
        self.addCleanup(patcher.stop)

    def download(self, **kwargs):
        def before(url, hop):
            self.events.append(("before", hop))
        def pause(seconds):
            self.events.append(("pause", seconds))
        options = {"before_request": before, "pause": pause}
        options.update(kwargs)
        return t.download(URL, self.dest, "image", **options)

    def fail(self, code, **kwargs):
        with self.assertRaises(t.TransferError) as caught:
            self.download(**kwargs)
        self.assertEqual(caught.exception.code, code)
        self.assertNotIn("sig=", str(caught.exception))
        self.assertNotIn(URL, str(caught.exception))
        return caught.exception

    def test_success_stream_hash_preserves_exact_signed_target(self):
        response = Response(chunk_size=3)
        self.responses.append(response)
        result = self.download()
        self.assertEqual(result, {"extension": "png", "width": 2, "height": 1, "size": len(png_bytes()),
                                  "content_type": "image/png", "sha256": hashlib.sha256(png_bytes()).hexdigest()})
        self.assertEqual(self.dest.read_bytes(), png_bytes())
        self.assertEqual(self.requests[0][0].request_target, "/a%2Fb.png?sig=A%2bB%2FC&v=1&v=2&empty=")
        self.assertEqual(self.requests[0][1], "8.8.8.8")
        self.assertEqual(self.events, [("before", 0), ("request", 0), ("close", 0)])
        self.assertTrue(response.closed)

    def test_new_exclusive_part_never_overwrites(self):
        self.dest.write_bytes(b"owned-data")
        self.fail("destination_exists")
        self.assertEqual(self.dest.read_bytes(), b"owned-data")
        self.mock_request.assert_not_called()

    def test_dependency_failure_prevents_requests_and_destination(self):
        with mock.patch.object(t, "dependencies", side_effect=t.TransferError("dependency_missing", "Missing validator.")):
            self.fail("dependency_missing")
        self.assertFalse(self.dest.exists())
        self.mock_request.assert_not_called()

    def test_bad_destination_suffix_prevents_requests(self):
        self.dest = self.dest.with_suffix(".mp4")
        self.fail("invalid_destination")
        self.mock_request.assert_not_called()

    def test_guard_exception_prevents_network(self):
        def reject(*args):
            raise RuntimeError("durable budget failed")
        with self.assertRaisesRegex(RuntimeError, "durable budget failed"):
            self.download(before_request=reject)
        self.mock_request.assert_not_called()

    def test_cancel_before_request(self):
        self.fail("cancelled", cancel=lambda: True)
        self.mock_request.assert_not_called()

    def test_all_non_200_statuses_stop_first_request(self):
        for status, code in [(401, "access_denied_unknown"), (403, "access_denied_unknown"),
                             (404, "url_unavailable"), (410, "url_unavailable"), (500, "transfer_failed"),
                             (204, "transfer_failed"), (206, "transfer_failed")]:
            with self.subTest(status=status):
                if self.dest.exists():
                    self.dest.unlink()
                before = len(self.requests)
                self.responses.append(Response(status, b"unknown diagnostic", headers={}))
                error = self.fail(code, max_redirects=3)
                self.assertEqual(error.status, status)
                self.assertEqual(len(self.requests), before + 1)

    def test_error_classification_bounded_and_no_body_leak(self):
        for body, code in [(b"URL signature expired", "url_expired"), (b"Bad URL hash", "signature_rejected"),
                           (b"url signature mismatch", "signature_rejected")]:
            with self.subTest(code=code):
                if self.dest.exists():
                    self.dest.unlink()
                response = Response(403, body + b" secret " + b"x" * 9000, headers={})
                self.responses.append(response)
                error = self.fail(code)
                self.assertNotIn("secret", str(error))
                self.assertEqual(response.body.tell(), 8192)
                self.assertLessEqual(max(response.read_sizes), 8192)

    def test_429_requires_review_with_unknown_or_valid_wait(self):
        for value in [None, "invalid", "60"]:
            with self.subTest(value=value), mock.patch.object(t.time, "time", return_value=1000):
                if self.dest.exists():
                    self.dest.unlink()
                self.responses.append(Response(429, b"limited", headers={"Retry-After": value} if value else {}))
                error = self.fail("rate_limited")
                self.assertTrue(error.requires_review)
                self.assertEqual(error.retry_at, 1060 if value == "60" else None)

    def test_503_retry_after_persists_date(self):
        with mock.patch.object(t.time, "time", return_value=1000):
            self.responses.append(Response(503, b"unavailable", headers={"Retry-After": formatdate(1120, usegmt=True)}))
            self.assertEqual(self.fail("server_unavailable").retry_at, 1120)

    def test_redirect_close_then_wait_then_account_every_request(self):
        first = Response(302, headers={"Location": "https://media.fbcdn.net/new%2Fpath?sig=%2b&A=1&A=2", "Retry-After": "12"})
        self.responses += [first, Response()]
        with mock.patch.object(t.time, "time", return_value=1000), mock.patch.object(t.random, "uniform", return_value=7):
            self.download(max_redirects=1)
        self.assertEqual(self.events, [("before", 0), ("request", 0), ("close", 0), ("pause", 12),
                                      ("before", 1), ("request", 1), ("close", 1)])
        self.assertEqual(self.requests[1][0].hostname, "media.fbcdn.net")
        self.assertEqual(self.requests[1][0].request_target, "/new%2Fpath?sig=%2b&A=1&A=2")
        self.assertEqual(self.resolve.call_count, 2)

    def test_redirect_to_429_stops_with_no_third_get(self):
        self.responses += [Response(302, headers={"Location": "/next"}), Response(429, b"limited", headers={})]
        self.fail("rate_limited", max_redirects=3)
        self.assertEqual(len(self.requests), 2)

    def test_redirect_default_zero_and_wait_preserved(self):
        with mock.patch.object(t.time, "time", return_value=1000):
            self.responses.append(Response(302, headers={"Location": "/next", "Retry-After": "30"}))
            error = self.fail("redirect_limit")
        self.assertEqual(error.retry_at, 1030)
        self.assertEqual(len(self.requests), 1)

    def test_redirect_host_and_fragment_rechecked_before_second_request(self):
        for location, code in [("https://evil.test/a", "unsupported_host"), ("/next#x", "unsafe_redirect"),
                               ("https://user@cdninstagram.com/a", "unsafe_url"), ("http://cdninstagram.com/a", "unsafe_url")]:
            with self.subTest(location=location):
                if self.dest.exists():
                    self.dest.unlink()
                before = len(self.requests)
                self.responses.append(Response(302, headers={"Location": location}))
                self.fail(code, max_redirects=1)
                self.assertEqual(len(self.requests), before + 1)

    def test_redirect_server_wait_exceeds_total_budget(self):
        self.responses.append(Response(302, headers={"Location": "/next", "Retry-After": "600"}))
        error = self.fail("timeout", max_redirects=1, total_timeout_seconds=60)
        self.assertIsNotNone(error.retry_at)
        self.assertEqual(len(self.requests), 1)
        self.assertFalse(any(event[0] == "pause" for event in self.events))

    def test_file_limit_known_before_body_and_unknown_stream_limit(self):
        self.responses.append(Response())
        self.fail("size_limit", max_bytes=10)
        self.assertEqual(self.dest.stat().st_size, 0)
        self.dest.unlink()
        self.responses.append(Response(headers={"Content-Type": "image/png"}))
        self.fail("size_limit", max_bytes=10)
        self.assertLessEqual(self.dest.stat().st_size, 10)

    def test_length_mismatch_rejects_even_decodable_image(self):
        self.responses.append(Response(headers={"Content-Type": "image/png", "Content-Length": str(len(png_bytes()) + 10)}))
        self.fail("length_mismatch")
        self.validate.assert_not_called()
        self.assertTrue(self.dest.exists())

    def test_html_or_kind_mismatch_never_validates_as_media(self):
        for body, content_type in [(b"<html>Access denied</html>", "image/png"), (png_bytes(), "text/html")]:
            with self.subTest(content_type=content_type):
                if self.dest.exists():
                    self.dest.unlink()
                self.responses.append(Response(body=body, headers={"Content-Type": content_type}))
                self.fail("unexpected_response")
                self.validate.assert_not_called()

    def test_ambiguous_and_encoded_framing_rejected(self):
        for extra in [[("Content-Length", "1"), ("Content-Length", "1")],
                      [("Content-Length", "1"), ("Transfer-Encoding", "chunked")],
                      [("Content-Length", "garbage")], [("Content-Encoding", "gzip")],
                      [("Content-Range", "bytes 0-9/99")]]:
            with self.subTest(extra=extra):
                if self.dest.exists():
                    self.dest.unlink()
                self.responses.append(Response(headers=[("Content-Type", "image/png")] + extra))
                self.fail("unexpected_response")

    def test_invalid_media_validator_keeps_part_and_stops(self):
        self.responses.append(Response())
        self.validate.side_effect = t.TransferError("invalid_media", "Invalid local media.")
        self.fail("invalid_media")
        self.assertEqual(self.dest.read_bytes(), png_bytes())
        self.assertEqual(len(self.requests), 1)

    def test_invalid_policy_preflight(self):
        for kwargs in [{"max_redirects": 4}, {"max_redirects": True}, {"max_bytes": 0},
                       {"timeout_seconds": float("nan")}, {"total_timeout_seconds": -1}]:
            with self.subTest(kwargs=kwargs):
                self.fail("invalid_policy", **kwargs)
                self.mock_request.assert_not_called()

    def test_stream_total_deadline_and_cancel_observed(self):
        response = Response(chunk_size=1)
        count = [0]
        original = response.read1
        def read(amount):
            count[0] += 1
            return original(amount)
        response.read1 = read
        self.responses.append(response)
        self.fail("cancelled", cancel=lambda: count[0] >= 2)
        self.assertEqual(len(self.requests), 1)
        self.assertTrue(response.closed)


class URLAndConnectionTests(unittest.TestCase):
    def test_url_boundary_rejections(self):
        for url in ["http://cdninstagram.com/a", "https://cdninstagram.com.evil.test/a", "https://evilcdninstagram.com/a",
                    "https://user:pass@cdninstagram.com/a", "https://cdninstagram.com:80/a", "https://cdninstagram.com:/a",
                    "https://cdninstagram.com./a", "https://cdninstagram.com/a#", "https://cdninstagram.com/\na",
                    "https://cdninstagram.com/ a", "https://cdninstagram.com/한글", "https://cdninstagram.com\\@evil.test/a",
                    "https://[::1]/a", "https://127.0.0.1/a", "https://cdninstagram.com//a", "https://cdninstagram.com/a\x7f"]:
            with self.subTest(url=url), self.assertRaises(t.TransferError):
                t.validate_url(url)

    def test_query_bytes_empty_query_and_case_preserved(self):
        for url, target in [("https://CDNINSTAGRAM.COM:443/a?", "/a?"),
                            ("https://fbcdn.net?sig=x%2B%2b&&x=", "/?sig=x%2B%2b&&x="),
                            ("https://fbcdn.net", "/")]:
            self.assertEqual(t.validate_url(url).request_target, target)

    def test_relative_redirect_does_not_rewrite_signed_path_or_empty_query(self):
        base = t.validate_url("https://cdninstagram.com/dir/old?sig=old")
        for location, expected in [("/a/../b?sig=%2b&&", "/a/../b?sig=%2b&&"),
                                   ("?", "/dir/old?"), ("next?sig=A%2f", "/dir/next?sig=A%2f")]:
            self.assertEqual(t._redirect_target(base, location).request_target, expected)

    def test_dns_timeout_is_bounded_without_making_http_request(self):
        import threading
        release = threading.Event()
        def blocked(*args, **kwargs):
            release.wait(1)
            return []
        try:
            with mock.patch.object(t.socket, "getaddrinfo", side_effect=blocked):
                with self.assertRaises(t.TransferError) as caught:
                    t._resolve("cdninstagram.com", 0.02, deadline=t.time.monotonic() + 1, cancel=lambda: False)
                self.assertEqual(caught.exception.code, "timeout")
        finally:
            release.set()

    def test_dns_rejects_any_nonpublic_answer(self):
        for bad in ["127.0.0.1", "10.0.0.1", "169.254.169.254", "192.168.1.2", "::1", "fc00::1", "224.0.0.1"]:
            family = socket.AF_INET6 if ":" in bad else socket.AF_INET
            answers = [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("8.8.8.8", 443)),
                       (family, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (bad, 443))]
            with self.subTest(bad=bad), mock.patch.object(t.socket, "getaddrinfo", return_value=answers):
                with self.assertRaises(t.TransferError) as caught:
                    t._resolve("cdninstagram.com", 1, deadline=t.time.monotonic() + 1, cancel=lambda: False)
                self.assertEqual(caught.exception.code, "unsafe_address")

    def test_pinned_socket_no_second_dns_with_original_sni(self):
        tls_context, raw, wrapped = mock.Mock(), mock.Mock(), mock.Mock()
        tls_context.wrap_socket.return_value = wrapped
        with mock.patch.object(t, "_tls_context", return_value=tls_context), mock.patch.object(t.socket, "socket", return_value=raw), mock.patch.object(t.socket, "getaddrinfo") as resolver:
            connection = t._PinnedHTTPSConnection(t.validate_url(URL), "8.8.8.8", 30)
            connection.connect()
        resolver.assert_not_called()
        raw.connect.assert_called_once_with(("8.8.8.8", 443))
        tls_context.wrap_socket.assert_called_once_with(raw, server_hostname="scontent.example.cdninstagram.com", do_handshake_on_connect=False)
        wrapped.do_handshake.assert_called_once_with()

    def test_tls_requires_certificate_and_hostname_verification(self):
        context = t._tls_context()
        self.assertTrue(context.check_hostname)
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)

    def test_request_get_has_no_auth_cookies_proxy_or_head(self):
        connection = mock.Mock()
        response = Response()
        connection.getresponse.return_value = response
        with mock.patch.object(t, "_PinnedHTTPSConnection", return_value=connection), mock.patch.dict(os.environ, {"HTTPS_PROXY": "http://127.0.0.1:9", "HTTP_PROXY": "http://127.0.0.1:9"}):
            with t._request(t.validate_url(URL), "8.8.8.8", 30, deadline=t.time.monotonic() + 1, cancel=lambda: False):
                pass
        connection.request.assert_called_once_with("GET", t.validate_url(URL).request_target,
                                                   headers={"Accept-Encoding": "identity", "Connection": "close"})
        self.assertTrue(response.closed)

    def test_retry_after_seconds_dates_and_unknown(self):
        self.assertEqual(t.retry_after("60", now=1000), 1060)
        self.assertEqual(t.retry_after(formatdate(1120, usegmt=True), now=1000), 1120)
        self.assertEqual(t.retry_after(formatdate(900, usegmt=True), now=1000), 1000)
        for value in [None, "", "bad", "-10", "1.5", "9" * 200, "Wed, 21 Oct 2015 07:28:00"]:
            self.assertIsNone(t.retry_after(value, now=1000))

    def test_missing_validators_fail_dependency_check(self):
        with mock.patch.object(t.importlib, "import_module", side_effect=ImportError("private details")):
            with self.assertRaises(t.TransferError) as caught:
                t.dependencies("image")
            self.assertEqual(caught.exception.code, "dependency_missing")
            self.assertNotIn("private details", str(caught.exception))
        with mock.patch.object(t.shutil, "which", return_value=None):
            with self.assertRaises(t.TransferError):
                t.dependencies("video")


class MediaValidationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "media.part"
        self.deadline = t.time.monotonic() + 10

    def image_dep(self):
        try:
            return t.dependencies("image")
        except t.TransferError:
            self.skipTest("Pillow is not installed in this Python runtime")

    def test_generated_png_verifies_and_loads(self):
        dep = self.image_dep()
        self.path.write_bytes(png_bytes())
        self.assertEqual(t._image_metadata(self.path, dep, "image/png", self.deadline, lambda: False),
                         {"extension": "png", "width": 2, "height": 1})

    def test_truncated_png_and_mime_mismatch_fail(self):
        dep = self.image_dep()
        for data, mime in [(png_bytes()[:-10], "image/png"), (png_bytes(), "image/jpeg")]:
            with self.subTest(mime=mime):
                self.path.write_bytes(data)
                with self.assertRaises(t.TransferError) as caught:
                    t._image_metadata(self.path, dep, mime, self.deadline, lambda: False)
                self.assertEqual(caught.exception.code, "invalid_media")

    def test_mp4_truncated_box_and_missing_boxes_fail(self):
        for data in [struct.pack(">I4s", 100, b"ftyp") + b"isom", struct.pack(">I4s", 12, b"ftyp") + b"isom",
                     struct.pack(">I4s", 1, b"ftyp") + b"\x00"]:
            self.path.write_bytes(data)
            with self.assertRaises(t.TransferError) as caught:
                t._mp4_boxes(self.path, self.deadline, lambda: False)
            self.assertEqual(caught.exception.code, "invalid_media")

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "Local ffmpeg/ffprobe unavailable")
    def test_generated_mp4_validates_packets_and_truncation_fails(self):
        subprocess.run([shutil.which("ffmpeg"), "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=16x16:r=1",
                        "-frames:v", "1", "-c:v", "mpeg4", "-f", "mp4", str(self.path)],
                       check=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=10)
        result = t._video_metadata(self.path, t.dependencies("video"), self.deadline, lambda: False)
        self.assertEqual(result, {"extension": "mp4", "width": 16, "height": 16})
        self.path.write_bytes(self.path.read_bytes()[:-7])
        with self.assertRaises(t.TransferError):
            t._video_metadata(self.path, t.dependencies("video"), self.deadline, lambda: False)


if __name__ == "__main__":
    unittest.main()
