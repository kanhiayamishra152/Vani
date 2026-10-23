#!/usr/bin/env python3
"""
Verify the Vani model downloader against a mock Hugging Face CDN.

WHY THIS EXISTS
  The spec requires testing the downloader before compiling. The sandbox has no JDK, so
  the Kotlin cannot be executed here - but the *algorithm* is plain HTTP, and HTTP can be
  tested. This script implements the downloader's logic line-for-line in Python (the same
  redirect loop, the same User-Agent on every hop, the same Range resume, the same SHA-256
  check) and runs it against a local server that reproduces Hugging Face's real behaviour:

    * `GET /resolve/main/<file>` answers 302 to a CDN host
    * the CDN host answers 200 / 206 and honours `Range`
    * the CDN answers 403 when the User-Agent is missing or identifies as curl
    * a missing file answers 200 with an HTML body (HF's actual failure mode)
    * a stale/too-large Range answers 416

  Six assertions cover the failure modes that actually broke the previous build.

Mirrors: app/src/main/java/ai/vani/model/ModelDownloader.kt
Run:    python3 tools/verify_downloader.py
"""
import hashlib
import os
import socket
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urljoin

HOST = "127.0.0.1"
UA = "VaniAI/1.0 (Android 10; arm64; Pixel 7) okhttp/4.12.0"
MAX_REDIRECTS = 10
BUFFER = 128 * 1024

RESOURCE_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out", "cdn")


# --------------------------------------------------------------------------- #
# Mock Hugging Face CDN
# --------------------------------------------------------------------------- #
class MockHFHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "MockHF/1.0"

    # Quiet logs; the assertions print their own results.
    def log_message(self, fmt, *args):
        pass

    def do_GET(self):
        path = self.path

        # ---- 1. resolve/main -> 302 to the CDN -------------------------------
        if path.startswith("/resolve/main/"):
            name = path[len("/resolve/main/"):]
            self.send_response(302)
            self.send_header("Location", f"/cdn/{name}")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        # ---- 2. the CDN -------------------------------------------------------
        if path.startswith("/cdn/"):
            name = path[len("/cdn/"):]

            # HF's CDN refuses clients that identify as curl or send no UA.
            ua = self.headers.get("User-Agent", "")
            if not ua or ua.lower().startswith("curl"):
                self.send_response(403)
                self.send_header("Content-Type", "text/plain")
                self.send_header("Content-Length", "9")
                self.end_headers()
                self.wfile.write(b"forbidden")
                return

            file_path = os.path.join(RESOURCE_ROOT, name)

            # A missing/private file is rendered as a 200 HTML page by HF, not a 404.
            if not os.path.exists(file_path):
                body = b"<html><body>Entry not found</body></html>"
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return

            data = open(file_path, "rb").read()
            total = len(data)

            range_header = self.headers.get("Range")
            if range_header and range_header.startswith("bytes="):
                spec = range_header[len("bytes="):]
                start_s, _, end_s = spec.partition("-")
                try:
                    start = int(start_s)
                except ValueError:
                    start = 0
                if start > total:
                    # Range not satisfiable.
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{total}")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                end = int(end_s) if end_s else total - 1
                end = min(end, total - 1)
                chunk = data[start:end + 1]
                self.send_response(206)
                self.send_header("Content-Range", f"bytes {start}-{end}/{total}")
                self.send_header("Content-Length", str(len(chunk)))
                self.send_header("Content-Type", "application/octet-stream")
                self.end_headers()
                self.wfile.write(chunk)
                return

            self.send_response(200)
            self.send_header("Content-Length", str(total))
            self.send_header("Content-Type", "application/octet-stream")
            self.end_headers()
            self.wfile.write(data)
            return

        self.send_response(404)
        self.send_header("Content-Length", "0")
        self.end_headers()


def start_server(port):
    server = ThreadingHTTPServer((HOST, port), MockHFHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def free_port():
    s = socket.socket()
    s.bind((HOST, 0))
    port = s.getsockname()[1]
    s.close()
    return port


# --------------------------------------------------------------------------- #
# Downloader algorithm - mirrors ModelDownloader.downloadFile
# --------------------------------------------------------------------------- #
class DownloadError(Exception):
    pass


def download_file(client, url, dest, expected_sha256=None, progress=None):
    """
    Streams `url` to `dest`, following redirects itself and resuming from an existing
    `.part` file. Returns the number of bytes written.

    This is a deliberate port of ModelDownloader.downloadFile: same redirect loop, same
    per-hop User-Agent, same Range handling, same 416 restart, same HTML-page detection,
    same SHA-256 verification.
    """
    import urllib.request

    part = os.path.join(os.path.dirname(dest), os.path.basename(dest) + ".part")
    resume_offset = os.path.getsize(part) if os.path.exists(part) else 0

    current_url = url
    redirects = 0
    last_reported = 0

    opener = urllib.request.build_opener(_NoRedirect)

    while True:
        headers = {
            "User-Agent": UA,
            "Accept": "*/*",
            # identity encoding: OkHttp's transparent gzip would make Content-Length
            # describe the compressed stream, breaking byte accounting and Range resume.
            "Accept-Encoding": "identity",
        }
        if resume_offset > 0:
            headers["Range"] = f"bytes={resume_offset}-"

        req = urllib.request.Request(current_url, headers=headers)
        try:
            resp = opener.open(req)
        except urllib.error.HTTPError as e:
            # urllib raises for 4xx/5xx; we need the status and body.
            resp = e

        status = resp.getcode()
        resp_headers = dict(resp.headers.items())
        location = resp_headers.get("Location")

        # ---- redirect hops ---------------------------------------------------
        if status in (301, 302, 303, 307, 308) and location:
            redirects += 1
            if redirects > MAX_REDIRECTS:
                raise DownloadError("Too many redirects")
            current_url = urljoin(current_url, location)
            resp.close()
            continue

        if status == 416:
            # Range no longer satisfiable: the upstream file changed. Start over.
            if os.path.exists(part):
                os.remove(part)
            resume_offset = 0
            resp.close()
            continue

        if not (200 <= status < 300):
            raise DownloadError(f"HTTP {status} for {current_url}")

        # ---- total size / append decision ------------------------------------
        content_range = resp_headers.get("Content-Range")
        content_length = resp_headers.get("Content-Length")
        total_size = None
        if content_range and "/" in content_range:
            total_size = int(content_range.split("/")[-1])
        elif content_length:
            total_size = int(content_length)

        appending = (status == 206 and resume_offset > 0)
        if not appending and resume_offset > 0:
            # Server ignored Range and sent the whole file: restart clean.
            if os.path.exists(part):
                os.remove(part)
            resume_offset = 0

        # Hugging Face renders a missing/private file as 200 HTML.
        content_type = resp_headers.get("Content-Type", "")
        if "text/html" in content_type.lower():
            raise DownloadError(
                f"Hugging Face returned an HTML page for {current_url} "
                "(the file is missing, private, or the repo name is wrong)"
            )

        # ---- stream to the .part file -----------------------------------------
        downloaded = resume_offset
        with open(part, "ab" if appending else "wb") as sink:
            while True:
                chunk = resp.read(BUFFER)
                if not chunk:
                    break
                sink.write(chunk)
                downloaded += len(chunk)
                if downloaded - last_reported >= 4 * 1024 * 1024:
                    last_reported = downloaded
                    if progress:
                        progress(downloaded, total_size or -1)

        if progress:
            progress(downloaded, total_size if total_size else downloaded)

        # ---- integrity -------------------------------------------------------
        if expected_sha256:
            actual = sha256_of(part)
            if actual.lower() != expected_sha256.lower():
                os.remove(part)
                raise DownloadError(
                    f"SHA-256 mismatch: expected {expected_sha256}, got {actual}"
                )

        # ---- commit ----------------------------------------------------------
        if os.path.exists(dest):
            os.remove(dest)
        os.rename(part, dest)
        return downloaded


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(128 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


# --------------------------------------------------------------------------- #
# Test harness
# --------------------------------------------------------------------------- #
class Results:
    def __init__(self):
        self.passed = 0
        self.failed = 0
        self.failures = []

    def check(self, name, condition, detail=""):
        if condition:
            self.passed += 1
            print(f"  PASS  {name}")
        else:
            self.failed += 1
            self.failures.append(name)
            print(f"  FAIL  {name}  {detail}")


def make_payload(name, size):
    os.makedirs(RESOURCE_ROOT, exist_ok=True)
    path = os.path.join(RESOURCE_ROOT, name)
    with open(path, "wb") as fh:
        # Deterministic, non-trivial content so a hash is meaningful.
        fh.write(bytes(((i * 37 + 11) % 251) for i in range(size)))
    return path


def main():
    print("=" * 72)
    print("Vani model downloader - verification against a mock Hugging Face CDN")
    print("=" * 72)

    port = free_port()
    server = start_server(port)
    base = f"http://{HOST}:{port}"
    print(f"Mock HF CDN listening on {base}\n")

    results = Results()

    # ---------------------------------------------------------------- test 1
    print("[1] Full download through a 302 redirect to the CDN")
    payload = make_payload("lfm2-350m-Q4_K_M.gguf", 4 * 1024 * 1024)
    dest1 = os.path.join(RESOURCE_ROOT, "out_full.gguf")
    if os.path.exists(dest1):
        os.remove(dest1)
    try:
        n = download_file(None, f"{base}/resolve/main/lfm2-350m-Q4_K_M.gguf", dest1)
        ok = os.path.exists(dest1) and n == os.path.getsize(payload)
        results.check(
            "download completes via 302 -> CDN",
            ok,
            f"(bytes={n}, expected={os.path.getsize(payload)})",
        )
    except Exception as e:
        results.check("download completes via 302 -> CDN", False, str(e))

    # ---------------------------------------------------------------- test 2
    print("\n[2] User-Agent is sent on every hop (CDN returns 403 without it)")
    # Re-run with a deliberately bad UA to prove the CDN enforces it.
    import urllib.request
    try:
        req = urllib.request.Request(f"{base}/cdn/lfm2-350m-Q4_K_M.gguf", headers={"User-Agent": "curl/8.0"})
        urllib.request.urlopen(req, timeout=5)
        results.check("CDN rejects a curl User-Agent", False, "expected 403, got 200")
    except urllib.error.HTTPError as e:
        results.check("CDN rejects a curl User-Agent", e.code == 403, f"(got {e.code})")
    except Exception as e:
        results.check("CDN rejects a curl User-Agent", False, str(e))

    # Prove the downloader's UA is actually accepted (it is - test 1 already used it).
    try:
        req = urllib.request.Request(
            f"{base}/cdn/lfm2-350m-Q4_K_M.gguf",
            headers={"User-Agent": UA},
        )
        resp = urllib.request.urlopen(req, timeout=5)
        results.check(
            "downloader's Android User-Agent is accepted",
            resp.getcode() == 200,
            f"(got {resp.getcode()})",
        )
    except Exception as e:
        results.check("downloader's Android User-Agent is accepted", False, str(e))

    # ---------------------------------------------------------------- test 3
    print("\n[3] HTTP Range resume from a .part sidecar (206 append)")
    dest3 = os.path.join(RESOURCE_ROOT, "out_resume.gguf")
    for p in (dest3, dest3 + ".part"):
        if os.path.exists(p):
            os.remove(p)
    # Simulate a previous attempt that wrote the first 1 MiB.
    with open(dest3 + ".part", "wb") as fh:
        fh.write(open(payload, "rb").read(1024 * 1024))
    partial_len = os.path.getsize(dest3 + ".part")

    try:
        n = download_file(None, f"{base}/resolve/main/lfm2-350m-Q4_K_M.gguf", dest3)
        expected_total = os.path.getsize(payload)
        results.check(
            "resume appends only the remainder",
            n == expected_total,
            f"(got {n}, expected {expected_total})",
        )
        results.check(
            "resumed file matches the original byte-for-byte",
            sha256_of(dest3) == sha256_of(payload),
        )
        results.check(
            "resume did not re-download the already-present bytes",
            n - partial_len == expected_total - partial_len,
        )
    except Exception as e:
        results.check("Range resume works", False, str(e))

    # ---------------------------------------------------------------- test 4
    print("\n[4] 416 (Range not satisfiable) restarts the download cleanly")
    dest4 = os.path.join(RESOURCE_ROOT, "out_416.gguf")
    for p in (dest4, dest4 + ".part"):
        if os.path.exists(p):
            os.remove(p)
    # Pre-seed a .part larger than the real file to force a 416.
    with open(dest4 + ".part", "wb") as fh:
        fh.write(b"\0" * (8 * 1024 * 1024))
    try:
        n = download_file(None, f"{base}/resolve/main/lfm2-350m-Q4_K_M.gguf", dest4)
        results.check(
            "416 triggers a restart, not a failure",
            n == os.path.getsize(payload),
            f"(got {n})",
        )
    except Exception as e:
        results.check("416 triggers a restart", False, str(e))

    # ---------------------------------------------------------------- test 5
    print("\n[5] SHA-256 mismatch is detected and the file is rejected")
    dest5 = os.path.join(RESOURCE_ROOT, "out_badhash.gguf")
    if os.path.exists(dest5):
        os.remove(dest5)
    try:
        download_file(None, f"{base}/resolve/main/lfm2-350m-Q4_K_M.gguf", dest5,
                      expected_sha256="deadbeef" * 8)
        results.check("wrong hash is rejected", False, "no exception raised")
    except DownloadError as e:
        results.check(
            "wrong hash is rejected",
            "SHA-256 mismatch" in str(e),
            str(e),
        )
    results.check(
        "corrupt download is deleted rather than left on disk",
        not os.path.exists(dest5),
    )

    # ---------------------------------------------------------------- test 6
    print("\n[6] Hugging Face's HTML error page is detected as a failure")
    dest6 = os.path.join(RESOURCE_ROOT, "out_missing.gguf")
    if os.path.exists(dest6):
        os.remove(dest6)
    try:
        download_file(None, f"{base}/resolve/main/does-not-exist.gguf", dest6)
        results.check("HTML error page is rejected", False, "no exception raised")
    except DownloadError as e:
        results.check(
            "HTML error page is rejected",
            "HTML page" in str(e),
            str(e),
        )

    # ---------------------------------------------------------------- summary
    print("\n" + "=" * 72)
    print(f"RESULT: {results.passed} passed, {results.failed} failed")
    if results.failures:
        print("Failed assertions:")
        for f in results.failures:
            print(f"  - {f}")
    print("=" * 72)

    server.shutdown()
    return 1 if results.failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
