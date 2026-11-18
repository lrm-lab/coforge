#!/usr/bin/env python3
"""Browser desktop on VNC_WS_PORT.

The page talks WebSocket. This process checks a token, logs into the local VNC
server with the password kept in the container, and then gives the browser an
open session. The VNC password is not sent to the page.
"""
import base64
import hashlib
import hmac
import importlib.util
import json
import os
import posixpath
import secrets
import socket
import threading
from urllib.parse import parse_qs, urlsplit

from vnc_bridge import BufferedSocket, bridge
from vnc_des import obfuscate_vnc_password

WS_PORT = int(os.environ.get("VNC_WS_PORT", "6080"))
NOVNC_ROOT = "/usr/share/novnc"
PAGE_PATH = "/usr/local/share/coforge/vnc-desktop.html"
TOKEN_PATH = "/root/.vnc/ws-token.txt"
GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def log(message: str) -> None:
    print(f"[vnc-web] {message}", flush=True)


def prepare_token() -> str:
    os.makedirs("/root/.vnc", mode=0o700, exist_ok=True)
    token = os.environ.get("VNC_WS_TOKEN", "").strip()
    if token:
        log(f"web desktop on :{WS_PORT}; using VNC_WS_TOKEN")
        return token
    token = secrets.token_urlsafe(24)
    with open(TOKEN_PATH, "w", encoding="utf-8") as handle:
        handle.write(token + "\n")
    os.chmod(TOKEN_PATH, 0o600)
    log(f"web desktop on :{WS_PORT}; token written to {TOKEN_PATH}")
    return token


def token_ok(presented: str, expected: str) -> bool:
    got = presented.encode()
    want = expected.encode()
    if len(got) != len(want):
        return False
    return hmac.compare_digest(got, want)


def header_map(head: str) -> dict[str, str]:
    lines = head.split("\r\n")
    found = {}
    for line in lines[1:]:
        if ":" not in line:
            continue
        name, value = line.split(":", 1)
        found[name.strip().lower()] = value.strip()
    return found


def request_token(headers: dict[str, str], query: str) -> str:
    if headers.get("x-vnc-token"):
        return headers["x-vnc-token"]
    values = parse_qs(query, keep_blank_values=False).get("token") or []
    return values[0] if values else ""


def send_http(conn: socket.socket, status: str, body: bytes, content_type: str) -> None:
    head = (
        f"HTTP/1.1 {status}\r\n"
        f"Content-Type: {content_type}\r\n"
        f"Content-Length: {len(body)}\r\n"
        "Cache-Control: no-store\r\n"
        "Connection: close\r\n"
        "\r\n"
    )
    conn.sendall(head.encode() + body)


def content_type(path: str) -> str:
    ext = os.path.splitext(path)[1].lower()
    return {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".ico": "image/x-icon",
        ".json": "application/json",
        ".woff": "font/woff",
        ".woff2": "font/woff2",
    }.get(ext, "application/octet-stream")


def novnc_file(url_path: str) -> str:
    rel = posixpath.normpath(url_path).lstrip("/")
    full = os.path.normpath(os.path.join(NOVNC_ROOT, rel))
    root = os.path.normpath(NOVNC_ROOT)
    if full != root and not full.startswith(root + os.sep):
        raise FileNotFoundError(url_path)
    if not os.path.isfile(full):
        raise FileNotFoundError(url_path)
    return full


def load_page_fill():
    sibling = os.path.join(os.path.dirname(os.path.abspath(__file__)), "page-fill.py")
    spec = importlib.util.spec_from_file_location("page_fill", sibling)
    if spec is None or spec.loader is None:
        raise RuntimeError("page-fill.py is missing")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read_chunked(conn: socket.socket, rest: bytes):
    buf = bytearray(rest)
    body = bytearray()

    def need(size: int) -> bool:
        while len(buf) < size:
            chunk = conn.recv(4096)
            if not chunk:
                return False
            buf.extend(chunk)
        return True

    while True:
        while b"\r\n" not in buf:
            chunk = conn.recv(4096)
            if not chunk:
                return None
            buf.extend(chunk)
        line, _, leftover = bytes(buf).partition(b"\r\n")
        buf[:] = leftover
        try:
            size = int(line.split(b";", 1)[0].strip(), 16)
        except ValueError:
            return None
        if size == 0:
            while b"\r\n" not in buf:
                chunk = conn.recv(4096)
                if not chunk:
                    break
                buf.extend(chunk)
            return bytes(body)
        if size < 0 or len(body) + size > 65536:
            return None
        if not need(size + 2):
            return None
        body.extend(buf[:size])
        del buf[:size]
        if buf[:2] != b"\r\n":
            return None
        del buf[:2]


def read_body(conn: socket.socket, headers: dict, rest: bytes):
    if "chunked" in headers.get("transfer-encoding", "").lower():
        return read_chunked(conn, rest)
    raw = headers.get("content-length", "")
    if not raw.isdigit():
        return None
    length = int(raw)
    if length > 65536:
        return None
    body = bytearray(rest)
    while len(body) < length:
        chunk = conn.recv(length - len(body))
        if not chunk:
            return None
        body += chunk
    return bytes(body[:length])


def handle_fill(conn: socket.socket, headers: dict, query: str, rest: bytes, token: str, display: str) -> None:
    """Write the posted fields into Chromium. The body is not logged."""
    if not token_ok(request_token(headers, query), token):
        send_http(conn, "401 Unauthorized", b"", "text/plain")
        return
    body = read_body(conn, headers, rest)
    if body is None:
        send_http(conn, "400 Bad Request", b"", "text/plain")
        return
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError, TypeError):
        send_http(conn, "400 Bad Request", b"", "text/plain")
        return
    fields = payload.get("fields") if isinstance(payload, dict) else None
    module = load_page_fill()
    try:
        result = module.fill_display(display, fields)
    except module.FillError as exc:
        status = "409 Conflict" if exc.code == "browser_not_open" else "422 Unprocessable Entity"
        if exc.code in ("bad_request", "bad_display"):
            status = "400 Bad Request"
        reply = {"error": exc.code}
        if exc.field:
            reply["field"] = exc.field
        send_http(conn, status, json.dumps(reply).encode(), "application/json")
        return
    send_http(conn, "200 OK", json.dumps(result).encode(), "application/json")


def handle_inspect(conn: socket.socket, headers: dict, query: str, token: str, display: str) -> None:
    """List visible form fields on this display's Chromium. No values are returned."""
    if not token_ok(request_token(headers, query), token):
        send_http(conn, "401 Unauthorized", b"", "text/plain")
        return
    module = load_page_fill()
    try:
        result = module.inspect_display(display)
    except module.FillError as exc:
        status = "409 Conflict" if exc.code == "browser_not_open" else "422 Unprocessable Entity"
        if exc.code in ("bad_request", "bad_display"):
            status = "400 Bad Request"
        send_http(conn, status, json.dumps({"error": exc.code}).encode(), "application/json")
        return
    send_http(conn, "200 OK", json.dumps(result).encode(), "application/json")


def load_desktop_clipboard():
    sibling = os.path.join(os.path.dirname(os.path.abspath(__file__)), "desktop_clipboard.py")
    spec = importlib.util.spec_from_file_location("desktop_clipboard", sibling)
    if spec is None or spec.loader is None:
        raise RuntimeError("desktop_clipboard.py is missing")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def clipboard_error_status(code: str) -> str:
    if code == "clipboard_busy":
        return "409 Conflict"
    if code == "too_large":
        return "413 Payload Too Large"
    if code in ("xlib_missing", "owner_failed", "display_down"):
        return "503 Service Unavailable"
    return "400 Bad Request"


def handle_clipboard_post(
    conn: socket.socket,
    headers: dict,
    query: str,
    rest: bytes,
    token: str,
    display: str,
    xauthority: str | None = None,
) -> None:
    """Put posted plain text on the X CLIPBOARD as UTF-8. The body is not logged."""
    if not token_ok(request_token(headers, query), token):
        send_http(conn, "401 Unauthorized", b"", "text/plain")
        return
    body = read_body(conn, headers, rest)
    if body is None:
        send_http(conn, "400 Bad Request", b"", "text/plain")
        return
    try:
        text = body.decode("utf-8")
    except UnicodeError:
        send_http(conn, "400 Bad Request", b"", "text/plain")
        return
    module = load_desktop_clipboard()
    try:
        module.set_clipboard(display, text, xauthority=xauthority)
    except module.ClipboardError as exc:
        send_http(
            conn,
            clipboard_error_status(exc.code),
            json.dumps({"error": exc.code}).encode(),
            "application/json",
        )
        return
    send_http(conn, "200 OK", b'{"ok":true}', "application/json")


def handle_clipboard_get(
    conn: socket.socket,
    headers: dict,
    query: str,
    token: str,
    display: str,
    xauthority: str | None = None,
) -> None:
    """Return the X CLIPBOARD as UTF-8 plain text. The body is not logged."""
    if not token_ok(request_token(headers, query), token):
        send_http(conn, "401 Unauthorized", b"", "text/plain")
        return
    module = load_desktop_clipboard()
    try:
        text = module.get_clipboard(display, xauthority=xauthority)
    except module.ClipboardError as exc:
        send_http(
            conn,
            clipboard_error_status(exc.code),
            json.dumps({"error": exc.code}).encode(),
            "application/json",
        )
        return
    send_http(conn, "200 OK", text.encode("utf-8"), "text/plain; charset=utf-8")


def handle_http(conn: socket.socket, expected_token: str) -> None:
    data = bytearray()
    while b"\r\n\r\n" not in data:
        chunk = conn.recv(4096)
        if not chunk:
            return
        data += chunk
        if len(data) > 65536:
            send_http(conn, "431 Request Header Fields Too Large", b"", "text/plain")
            return
    head, rest = bytes(data).split(b"\r\n\r\n", 1)
    text = head.decode("iso-8859-1", "replace")
    request = text.split("\r\n", 1)[0]
    try:
        method, target, _proto = request.split(" ")
    except ValueError:
        send_http(conn, "400 Bad Request", b"", "text/plain")
        return
    parsed = urlsplit(target)
    headers = header_map(text)
    screen = SCREEN_TARGET(parsed.path) if SCREEN_TARGET is not None else None
    if method == "POST" and (parsed.path == "/fill" or (screen is not None and screen[1] == "fill")):
        agent_id = screen[0] if screen is not None and screen[1] == "fill" else ""
        display = os.environ.get("VNC_DISPLAY", ":1")
        if agent_id and SCREENS is not None:
            found = SCREENS.lookup(agent_id)
            if found and found.get("display"):
                display = found["display"]
        handle_fill(conn, headers, parsed.query, rest, expected_token, display)
        return
    if parsed.path == "/clipboard" or (screen is not None and screen[1] == "clipboard"):
        agent_id = screen[0] if screen is not None and screen[1] == "clipboard" else ""
        display = os.environ.get("VNC_DISPLAY", ":1")
        xauthority = None
        if agent_id and SCREENS is not None:
            found = SCREENS.lookup(agent_id)
            if found and found.get("display"):
                display = found["display"]
                xauthority = found.get("xauthority")
        if method == "POST":
            handle_clipboard_post(
                conn, headers, parsed.query, rest, expected_token, display, xauthority
            )
            return
        if method == "GET":
            handle_clipboard_get(
                conn, headers, parsed.query, expected_token, display, xauthority
            )
            return
        send_http(conn, "405 Method Not Allowed", b"", "text/plain")
        return
    if method == "GET" and (
        parsed.path == "/inspect" or (screen is not None and screen[1] == "inspect")
    ):
        agent_id = screen[0] if screen is not None and screen[1] == "inspect" else ""
        display = os.environ.get("VNC_DISPLAY", ":1")
        if agent_id and SCREENS is not None:
            found = SCREENS.lookup(agent_id)
            if found and found.get("display"):
                display = found["display"]
        handle_inspect(conn, headers, parsed.query, expected_token, display)
        return
    if screen is not None and method == "GET":
        agent_id, kind = screen
        if kind == "page":
            with open(PAGE_PATH, "rb") as handle:
                send_http(conn, "200 OK", handle.read(), "text/html; charset=utf-8")
            return
        if kind == "socket":
            if not token_ok(request_token(headers, parsed.query), expected_token):
                send_http(conn, "401 Unauthorized", b"", "text/plain")
                return
            key = headers.get("sec-websocket-key", "")
            if not key:
                send_http(conn, "400 Bad Request", b"", "text/plain")
                return
            accept = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
            reply = (
                "HTTP/1.1 101 Switching Protocols\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                f"Sec-WebSocket-Accept: {accept}\r\n"
                "\r\n"
            )
            conn.sendall(reply.encode())
            try:
                port = SCREENS.open_viewer(agent_id)
                bridge(BufferedSocket(conn, rest), port)
            finally:
                SCREENS.close_viewer(agent_id)
            return
        try:
            path = novnc_file("/" + kind)
        except FileNotFoundError:
            send_http(conn, "404 Not Found", b"", "text/plain")
            return
        with open(path, "rb") as handle:
            send_http(conn, "200 OK", handle.read(), content_type(path))
        return
    if method == "GET" and parsed.path in ("/", "/desktop.html"):
        query = f"?{parsed.query}" if parsed.query else ""
        if parsed.path == "/":
            body = f"HTTP/1.1 302 Found\r\nLocation: /desktop.html{query}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            conn.sendall(body.encode())
            return
        with open(PAGE_PATH, "rb") as handle:
            send_http(conn, "200 OK", handle.read(), "text/html; charset=utf-8")
        return
    if method == "GET" and parsed.path == "/websockify":
        if not token_ok(request_token(headers, parsed.query), expected_token):
            send_http(conn, "401 Unauthorized", b"", "text/plain")
            return
        key = headers.get("sec-websocket-key", "")
        if not key:
            send_http(conn, "400 Bad Request", b"", "text/plain")
            return
        accept = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
        reply = (
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Accept: {accept}\r\n"
            "\r\n"
        )
        conn.sendall(reply.encode())
        bridge(BufferedSocket(conn, rest))
        return
    if method == "GET" and parsed.path.startswith("/"):
        try:
            path = novnc_file(parsed.path)
        except FileNotFoundError:
            send_http(conn, "404 Not Found", b"", "text/plain")
            return
        with open(path, "rb") as handle:
            send_http(conn, "200 OK", handle.read(), content_type(path))
        return
    send_http(conn, "404 Not Found", b"", "text/plain")


def serve(conn: socket.socket, token: str) -> None:
    try:
        conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        handle_http(conn, token)
    except ConnectionError as exc:
        log(f"session closed: {exc}")
    except Exception as exc:
        log(f"session failed: {exc}")
    finally:
        try:
            conn.close()
        except OSError:
            pass


SCREENS = None
SCREEN_TARGET = None


def load_screens():
    sibling = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vnc-agent-screen.py")
    spec = importlib.util.spec_from_file_location("vnc_agent_screen", sibling)
    if spec is None or spec.loader is None:
        raise RuntimeError("vnc-agent-screen.py is missing")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> None:
    global SCREENS, SCREEN_TARGET
    token = prepare_token()
    try:
        module = load_screens()
        SCREENS = module.AgentScreens()
        SCREEN_TARGET = module.screen_target
        module.serve_control(SCREENS)
        log(f"agent screens on 127.0.0.1:{module.CONTROL_PORT}")
    except OSError as exc:
        log(f"agent screen control failed: {exc}")
    listener = socket.socket()
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("0.0.0.0", WS_PORT))
    listener.listen(8)
    while True:
        conn, _addr = listener.accept()
        threading.Thread(target=serve, args=(conn, token), daemon=True).start()


if __name__ == "__main__":
    main()
