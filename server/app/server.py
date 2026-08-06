"""
HTTP server: static frontend hosting + JSON API.

Built on :class:`http.server.ThreadingHTTPServer` so there are zero
dependencies to install. That is a deliberate constraint of this project - you
should be able to clone the folder and run ``python run.py`` on any machine
with Python 3.10+ and immediately play.

Static serving is intentionally hand-rolled rather than using
``SimpleHTTPRequestHandler`` so we can:
  * confine reads to ``web/`` (path traversal is impossible),
  * send correct MIME types with charsets,
  * set cache headers that suit development (revalidate HTML, cache vendor).
"""

from __future__ import annotations

import json
import mimetypes
import os
import posixpath
import socket
import sys
import threading
import traceback
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Optional
from urllib.parse import parse_qs, unquote, urlparse

from . import config
from .api import Api, Request
from .db import Database

# Ensure the few types we care about are correct regardless of the host
# machine's registry (Windows in particular likes to mislabel .js).
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("application/json", ".json")
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("text/css", ".css")


class GameHandler(BaseHTTPRequestHandler):
    """Serves ``/api/*`` as JSON and everything else from :data:`config.WEB_DIR`."""

    server_version = "NeonRush/1.0"
    protocol_version = "HTTP/1.1"

    # Injected by :func:`create_server`.
    api: Api
    web_dir: Path
    verbose: bool = False

    # -- logging ------------------------------------------------------------

    def log_message(self, fmt: str, *args) -> None:
        """Quieten the default per-request logging unless --verbose."""
        if self.verbose:
            sys.stderr.write(
                "[%s] %s - %s\n" % (self.log_date_time_string(), self.address_string(), fmt % args)
            )

    def log_error(self, fmt: str, *args) -> None:
        # Broken pipes are normal when a browser cancels a request.
        message = fmt % args
        if "Broken pipe" in message or "forcibly closed" in message:
            return
        sys.stderr.write("[error] %s\n" % message)

    # -- HTTP verbs ---------------------------------------------------------

    def do_GET(self) -> None:
        self._handle("GET")

    def do_HEAD(self) -> None:
        self._handle("HEAD")

    def do_POST(self) -> None:
        self._handle("POST")

    def do_OPTIONS(self) -> None:
        """CORS preflight, so the frontend can be hosted separately if wanted."""
        self.send_response(HTTPStatus.NO_CONTENT)
        self._cors()
        self.send_header("Allow", "GET, HEAD, POST, OPTIONS")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self.end_headers()

    # -- core dispatch ------------------------------------------------------

    def _handle(self, method: str) -> None:
        try:
            parsed = urlparse(self.path)
            path = unquote(parsed.path)
            if path.startswith("/api/"):
                self._handle_api(method, path, parse_qs(parsed.query))
            else:
                self._handle_static(method, path)
        except (BrokenPipeError, ConnectionResetError):
            # Client went away mid-response; nothing useful to do.
            pass
        except Exception:
            traceback.print_exc()
            try:
                self._send_json(500, {"ok": False, "error": "server_error"})
            except Exception:
                pass

    def _handle_api(self, method: str, path: str, query: dict) -> None:
        body: dict = {}
        if method == "POST":
            length = int(self.headers.get("Content-Length") or 0)
            if length > config.MAX_BODY_BYTES:
                self._send_json(413, {"ok": False, "error": "payload_too_large"})
                return
            raw = self.rfile.read(length) if length > 0 else b""
            if raw:
                try:
                    parsed_body = json.loads(raw.decode("utf-8"))
                except (ValueError, UnicodeDecodeError):
                    self._send_json(400, {"ok": False, "error": "invalid_json"})
                    return
                if not isinstance(parsed_body, dict):
                    self._send_json(400, {"ok": False, "error": "invalid_json"})
                    return
                body = parsed_body

        request = Request(
            method=method if method != "HEAD" else "GET",
            path=path.rstrip("/") or "/",
            query=query,
            body=body,
            headers={k.lower(): v for k, v in self.headers.items()},
            client_ip=self.client_address[0] if self.client_address else "0.0.0.0",
        )
        response = self.api.dispatch(request)
        self._send_json(response.status, response.data, extra=response.headers,
                        head_only=(method == "HEAD"))

    def _handle_static(self, method: str, path: str) -> None:
        target = self._resolve_static(path)
        if target is None:
            self._send_text(404, "Not found")
            return

        try:
            payload = target.read_bytes()
        except OSError:
            self._send_text(404, "Not found")
            return

        ctype, _ = mimetypes.guess_type(str(target))
        ctype = ctype or "application/octet-stream"
        if ctype.startswith("text/") or ctype in (
            "application/javascript", "application/json", "image/svg+xml"
        ):
            ctype += "; charset=utf-8"

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(payload)))
        # Vendored libraries are immutable; game source should always revalidate
        # so a hard refresh is never needed while iterating.
        if "/vendor/" in target.as_posix():
            self.send_header("Cache-Control", "public, max-age=86400")
        else:
            self.send_header("Cache-Control", "no-cache, must-revalidate")
        self._cors()
        self.end_headers()
        if method != "HEAD":
            self.wfile.write(payload)

    def _resolve_static(self, path: str) -> Optional[Path]:
        """
        Map a URL path to a file inside ``web_dir``, or ``None``.

        Any path that escapes ``web_dir`` after normalisation is rejected, so
        ``/../../secrets`` cannot be read.
        """
        clean = posixpath.normpath(path)
        if clean in ("/", ".", "//"):
            clean = "/index.html"
        # normpath collapses "..", but a leading one would still escape.
        parts = [p for p in clean.split("/") if p not in ("", ".", "..")]
        candidate = (self.web_dir / Path(*parts)) if parts else (self.web_dir / "index.html")

        try:
            resolved = candidate.resolve()
            root = self.web_dir.resolve()
            if not str(resolved).startswith(str(root)):
                return None
        except OSError:
            return None

        if resolved.is_dir():
            index = resolved / "index.html"
            return index if index.is_file() else None
        return resolved if resolved.is_file() else None

    # -- response helpers ---------------------------------------------------

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def _send_json(self, status: int, data: object, *, extra: Optional[dict] = None,
                   head_only: bool = False) -> None:
        payload = json.dumps(data, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self._cors()
        self.end_headers()
        if not head_only:
            self.wfile.write(payload)

    def _send_text(self, status: int, text: str) -> None:
        payload = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self._cors()
        self.end_headers()
        self.wfile.write(payload)


class GameServer(ThreadingHTTPServer):
    """Threaded server that reuses the address for quick restarts."""

    daemon_threads = True
    allow_reuse_address = True


def create_server(
    host: str = config.DEFAULT_HOST,
    port: int = config.DEFAULT_PORT,
    *,
    db_path: Optional[str] = None,
    web_dir: Optional[Path] = None,
    verbose: bool = False,
) -> tuple[GameServer, Database]:
    """
    Build (but do not start) the server.

    Returns the server plus the :class:`Database` so callers - including tests
    - can inspect state directly.
    """
    database = Database(db_path)
    database.prune_runs()
    api = Api(database)

    handler = type(
        "BoundGameHandler",
        (GameHandler,),
        {
            "api": api,
            "web_dir": Path(web_dir) if web_dir else config.WEB_DIR,
            "verbose": verbose,
        },
    )
    httpd = GameServer((host, port), handler)
    return httpd, database


def find_free_port(host: str, preferred: int, attempts: int = 20) -> int:
    """
    Return ``preferred`` if bindable, else scan upward for a free port.

    Saves the "Address already in use" dance when a previous run is still
    shutting down or another service owns 8000.
    """
    for offset in range(attempts):
        candidate = preferred + offset
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind((host, candidate))
                return candidate
            except OSError:
                continue
    raise OSError(f"No free port found in range {preferred}-{preferred + attempts - 1}")


def serve(
    host: str = config.DEFAULT_HOST,
    port: int = config.DEFAULT_PORT,
    *,
    db_path: Optional[str] = None,
    open_browser: bool = False,
    verbose: bool = False,
) -> None:
    """Run the server until interrupted."""
    port = find_free_port(host, port)
    httpd, database = create_server(host, port, db_path=db_path, verbose=verbose)
    url = f"http://{host}:{port}/"

    print("\n  NEON RUSH")
    print("  " + "-" * 34)
    print(f"  play      {url}")
    print(f"  database  {database.path}")
    print(f"  api       {url}api/health")
    print("  " + "-" * 34)
    print("  Ctrl+C to stop\n")

    if open_browser:
        import webbrowser
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  Shutting down...")
    finally:
        httpd.shutdown()
        httpd.server_close()
        database.close()
        print("  Stopped.")
