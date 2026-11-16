#!/usr/bin/env python3
"""Per-display Chromium CDP endpoints with a path token gate.

Chromium itself listens on a random loopback port. A small proxy listens on the
stable public port (9222 + display) and only forwards when the URL path starts
with /coforge-cdp/<token>/. Bare connect_over_cdp to the public port fails,
which stops agents from attaching to each other's browsers by scanning ports.
"""
from __future__ import annotations

import json
import os
import re
import secrets
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

TOKEN_RE = re.compile(r"^[0-9a-f]{32}$")
PREFIX = "/coforge-cdp"


def display_number(display: str | None) -> int:
    raw = (display or "").lstrip(":").split(".", 1)[0]
    if not raw.isdigit():
        raise ValueError("bad display")
    return int(raw)


def public_port(display: str | None) -> int:
    return 9222 + display_number(display)


def profile_dir(display: str | None, home: str | None = None) -> Path:
    root = home if home is not None else os.environ.get("HOME", "/root")
    return Path(root) / ".config" / "coforge-chromium" / str(display_number(display))


def token_path(profile: Path) -> Path:
    return profile / "cdp.token"


def backend_port_path(profile: Path) -> Path:
    return profile / "cdp.backend"


def proxy_pid_path(profile: Path) -> Path:
    return profile / "cdp-proxy.pid"


def ensure_token(profile: Path, preferred: str | None = None) -> str:
    profile.mkdir(parents=True, exist_ok=True)
    path = token_path(profile)
    if preferred and TOKEN_RE.fullmatch(preferred):
        path.write_text(preferred + "\n", encoding="utf-8")
        path.chmod(0o600)
        return preferred
    if path.is_file():
        value = path.read_text(encoding="utf-8").strip()
        if TOKEN_RE.fullmatch(value):
            return value
    value = secrets.token_hex(16)
    path.write_text(value + "\n", encoding="utf-8")
    path.chmod(0o600)
    return value


def read_token(profile: Path) -> str | None:
    path = token_path(profile)
    try:
        value = path.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return value if TOKEN_RE.fullmatch(value) else None


def endpoint_url(display: str | None, token: str, host: str = "127.0.0.1") -> str:
    return f"http://{host}:{public_port(display)}{PREFIX}/{token}/"


def allocate_loopback_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def read_backend_port(profile: Path, public: int | None = None) -> int | None:
    """Return Chromium's private CDP port. Never return the public proxy port."""
    candidates: list[Path] = [backend_port_path(profile), profile / "DevToolsActivePort"]
    for path in candidates:
        try:
            first = path.read_text(encoding="utf-8").splitlines()[0].strip()
        except (OSError, IndexError):
            continue
        if not first.isdigit():
            continue
        port = int(first)
        if port < 1 or port > 65535:
            continue
        # Legacy builds bound Chromium itself to 9222+display; that slot is now
        # the tokenizing proxy and must not be treated as the backend.
        if public is not None and port == public:
            continue
        return port
    return None


def write_backend_port(profile: Path, port: int) -> None:
    profile.mkdir(parents=True, exist_ok=True)
    path = backend_port_path(profile)
    path.write_text(f"{port}\n", encoding="utf-8")
    path.chmod(0o600)


def port_open(host: str, port: int, timeout: float = 0.2) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def proxy_healthy(display: str | None, token: str, timeout: float = 0.8) -> bool:
    url = endpoint_url(display, token) + "json/version"
    try:
        with urlopen(url, timeout=timeout) as response:
            return 200 <= response.status < 300
    except (HTTPError, URLError, TimeoutError, OSError):
        return False


def rewrite_cdp_payload(body: bytes, public_port_num: int, token: str) -> bytes:
    """Point websocket URLs at the tokenized public proxy, not the backend port."""
    try:
        text = body.decode("utf-8")
    except UnicodeDecodeError:
        return body
    # Replace any loopback ws/http debugger URL host:port with public+token path.
    pattern = re.compile(
        r"(?P<scheme>ws|http)://127\.0\.0\.1:(?P<port>\d+)(?P<path>/[^\s\"']*)"
    )

    def repl(match: re.Match) -> str:
        scheme = match.group("scheme")
        path = match.group("path") or "/"
        if path.startswith(f"{PREFIX}/"):
            return match.group(0)
        return f"{scheme}://127.0.0.1:{public_port_num}{PREFIX}/{token}{path}"

    return pattern.sub(repl, text).encode("utf-8")


def _split_token_path(path: str) -> tuple[str | None, str]:
    """Return (token, remainder) when path is /coforge-cdp/<token>/..."""
    if not path.startswith(PREFIX + "/"):
        return None, path
    rest = path[len(PREFIX) + 1 :]
    token, sep, remainder = rest.partition("/")
    if not TOKEN_RE.fullmatch(token):
        return None, path
    if not sep:
        remainder = ""
    return token, "/" + remainder


class _ProxyHandler(BaseHTTPRequestHandler):
    backend_port: int = 0
    public_port: int = 0
    token: str = ""

    def log_message(self, format: str, *args) -> None:  # noqa: A003
        return

    def do_GET(self) -> None:  # noqa: N802
        self._proxy()

    def do_POST(self) -> None:  # noqa: N802
        self._proxy()

    def do_PUT(self) -> None:  # noqa: N802
        self._proxy()

    def do_DELETE(self) -> None:  # noqa: N802
        self._proxy()

    def do_HEAD(self) -> None:  # noqa: N802
        self._proxy()

    def _forbidden(self) -> None:
        body = b"coforge-cdp: token required (use coforge-cdp-endpoint)\n"
        self.send_response(403)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _proxy(self) -> None:
        token, remainder = _split_token_path(self.path.split("?", 1)[0])
        query = ""
        if "?" in self.path:
            query = "?" + self.path.split("?", 1)[1]
        if token is None or token != self.token:
            self._forbidden()
            return
        upgrade = (self.headers.get("Upgrade") or "").lower()
        if upgrade == "websocket":
            self._websocket(remainder + query)
            return
        length = int(self.headers.get("Content-Length") or "0")
        payload = self.rfile.read(length) if length else b""
        url = f"http://127.0.0.1:{self.backend_port}{remainder}{query}"
        headers = {
            key: value
            for key, value in self.headers.items()
            if key.lower() not in ("host", "content-length", "connection")
        }
        headers["Host"] = f"127.0.0.1:{self.backend_port}"
        request = Request(url, data=payload or None, headers=headers, method=self.command)
        try:
            with urlopen(request, timeout=10) as response:
                body = response.read()
                content_type = response.headers.get("Content-Type", "")
                if "json" in content_type or remainder.startswith("/json"):
                    body = rewrite_cdp_payload(body, self.public_port, self.token)
                self.send_response(response.status)
                for key, value in response.headers.items():
                    if key.lower() in ("transfer-encoding", "connection", "content-length"):
                        continue
                    self.send_header(key, value)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(body)
        except HTTPError as exc:
            body = exc.read() or b""
            self.send_response(exc.code)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (URLError, TimeoutError, OSError):
            body = b"coforge-cdp: backend unavailable\n"
            self.send_response(502)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    def _websocket(self, path: str) -> None:
        try:
            backend = socket.create_connection(("127.0.0.1", self.backend_port), 5)
        except OSError:
            self._forbidden()
            return
        # Rebuild the upgrade request toward the backend.
        header_lines = [f"{self.command} {path} HTTP/1.1"]
        for key, value in self.headers.items():
            if key.lower() == "host":
                header_lines.append(f"Host: 127.0.0.1:{self.backend_port}")
            else:
                header_lines.append(f"{key}: {value}")
        header_lines.append("")
        header_lines.append("")
        try:
            backend.sendall("\r\n".join(header_lines).encode())
            # Tunnel client <-> backend. First pass the backend handshake back.
            self.connection.settimeout(30)
            backend.settimeout(30)
            # Raw tunnel: hand off the already-accepted client socket.
            client = self.connection
            # Send HTTP 101 from backend to client first.
            buf = b""
            while b"\r\n\r\n" not in buf:
                chunk = backend.recv(4096)
                if not chunk:
                    backend.close()
                    return
                buf += chunk
            client.sendall(buf)
            done = threading.Event()

            def pump(src, dst) -> None:
                try:
                    while not done.is_set():
                        data = src.recv(65536)
                        if not data:
                            break
                        dst.sendall(data)
                except OSError:
                    pass
                finally:
                    done.set()
                    try:
                        src.shutdown(socket.SHUT_RD)
                    except OSError:
                        pass
                    try:
                        dst.shutdown(socket.SHUT_WR)
                    except OSError:
                        pass

            threads = [
                threading.Thread(target=pump, args=(client, backend), daemon=True),
                threading.Thread(target=pump, args=(backend, client), daemon=True),
            ]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
        finally:
            try:
                backend.close()
            except OSError:
                pass


def serve_proxy(public: int, backend: int, token: str) -> ThreadingHTTPServer:
    handler = type(
        "Handler",
        (_ProxyHandler,),
        {"backend_port": backend, "public_port": public, "token": token},
    )
    server = ThreadingHTTPServer(("127.0.0.1", public), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def run_proxy_forever(public: int, backend: int, token: str) -> None:
    server = ThreadingHTTPServer(
        ("127.0.0.1", public),
        type(
            "Handler",
            (_ProxyHandler,),
            {"backend_port": backend, "public_port": public, "token": token},
        ),
    )
    server.serve_forever()


def resolve_endpoint(display: str | None = None, home: str | None = None) -> str:
    display = display if display is not None else os.environ.get("DISPLAY")
    if not display:
        raise SystemExit("DISPLAY unset; refuse CDP endpoint (avoid cross-agent desktop)")
    profile = profile_dir(display, home)
    token = os.environ.get("COFORGE_CDP_TOKEN") or read_token(profile)
    if not token:
        # Create token so launching chromium next can reuse it; still require proxy up.
        token = ensure_token(profile)
    env_token = os.environ.get("COFORGE_CDP_TOKEN")
    if env_token and TOKEN_RE.fullmatch(env_token):
        token = ensure_token(profile, preferred=env_token)
    return endpoint_url(display, token)


def sync_screen_token(display: str | None, token: str) -> None:
    screen = os.environ.get("COFORGE_SCREEN_DIR")
    if not screen:
        return
    path = Path(screen) / "cdp.token"
    try:
        path.write_text(token + "\n", encoding="utf-8")
        path.chmod(0o600)
    except OSError:
        pass


def ensure_proxy_process(display: str, backend: int, token: str, profile: Path) -> None:
    import subprocess

    public = public_port(display)
    if proxy_healthy(display, token):
        return
    # If public port is taken by a stale proxy with a different token, callers
    # must clear it; we still try to spawn (bind will fail loudly in the log).
    log = profile / "cdp-proxy.log"
    here = Path(__file__).resolve()
    cmd = [
        "python3",
        "-u",
        str(here),
        "proxy",
        "--public-port",
        str(public),
        "--backend-port",
        str(backend),
        "--token",
        token,
    ]
    profile.mkdir(parents=True, exist_ok=True)
    with open(log, "ab", buffering=0) as handle:
        proc = subprocess.Popen(
            cmd,
            stdout=handle,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    proxy_pid_path(profile).write_text(str(proc.pid) + "\n", encoding="utf-8")
    deadline = time.time() + 5
    while time.time() < deadline:
        if port_open("127.0.0.1", public):
            return
        if proc.poll() is not None:
            break
        time.sleep(0.05)
    raise RuntimeError("cdp proxy failed to listen")


def prepare_chromium_cdp(display: str | None = None, home: str | None = None) -> dict:
    """Ensure token + backend port + proxy; return env for launching Chromium."""
    display = display if display is not None else os.environ.get("DISPLAY", ":1")
    profile = profile_dir(display, home)
    preferred = os.environ.get("COFORGE_CDP_TOKEN")
    token = ensure_token(profile, preferred=preferred if preferred else None)
    sync_screen_token(display, token)

    public = public_port(display)
    existing = read_backend_port(profile, public=public)
    if existing is not None and port_open("127.0.0.1", existing):
        backend = existing
    else:
        backend = allocate_loopback_port()
        write_backend_port(profile, backend)

    ensure_proxy_process(display, backend, token, profile)
    return {
        "display": display,
        "profile": str(profile),
        "token": token,
        "backend_port": backend,
        "public_port": public,
        "endpoint": endpoint_url(display, token),
    }

def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(prog="coforge-cdp")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_endpoint = sub.add_parser("endpoint", help="Print tokenized CDP URL for $DISPLAY")
    p_endpoint.add_argument("--display", default=None)

    p_proxy = sub.add_parser("proxy", help="Run the tokenizing CDP proxy")
    p_proxy.add_argument("--public-port", type=int, required=True)
    p_proxy.add_argument("--backend-port", type=int, required=True)
    p_proxy.add_argument("--token", required=True)

    p_prep = sub.add_parser("prepare", help="Ensure proxy/token; print JSON")
    p_prep.add_argument("--display", default=None)

    args = parser.parse_args(argv)
    if args.cmd == "endpoint":
        print(resolve_endpoint(args.display))
        return 0
    if args.cmd == "proxy":
        if not TOKEN_RE.fullmatch(args.token):
            raise SystemExit("bad token")
        run_proxy_forever(args.public_port, args.backend_port, args.token)
        return 0
    if args.cmd == "prepare":
        print(json.dumps(prepare_chromium_cdp(args.display)))
        return 0
    raise SystemExit("unknown command")


if __name__ == "__main__":
    raise SystemExit(main())