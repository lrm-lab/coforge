"""Minimal CDP WebSocket client for page fill."""
import base64
import json
import os
import socket
from urllib.parse import urlsplit

from page_fill_cdp import FillError


class WebsocketCdp:
    def __init__(self, url: str) -> None:
        parsed = urlsplit(url)
        if parsed.scheme != "ws" or not parsed.hostname or not parsed.port:
            raise FillError("browser_not_open")
        self._sock = socket.create_connection((parsed.hostname, parsed.port), 5)
        self._sock.settimeout(8)
        path = parsed.path or "/"
        if parsed.query:
            path = f"{path}?{parsed.query}"
        key = base64.b64encode(os.urandom(16)).decode()
        host = f"{parsed.hostname}:{parsed.port}"
        request = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "\r\n"
        )
        self._sock.sendall(request.encode())
        header = b""
        while b"\r\n\r\n" not in header:
            chunk = self._sock.recv(4096)
            if not chunk:
                raise FillError("browser_not_open")
            header += chunk
            if len(header) > 65536:
                raise FillError("browser_not_open")
        status = header.split(b"\r\n", 1)[0]
        if b" 101 " not in status:
            raise FillError("browser_not_open")
        self._buf = bytearray(header.split(b"\r\n\r\n", 1)[1])
        self._next = 0

    def close(self) -> None:
        try:
            self._sock.close()
        except OSError:
            pass

    def call(self, method: str, params=None):
        self._next += 1
        ident = self._next
        body = {"id": ident, "method": method}
        if params is not None:
            body["params"] = params
        self._send(json.dumps(body).encode())
        while True:
            message = json.loads(self._recv())
            if message.get("id") != ident:
                continue
            if "error" in message:
                raise FillError("browser_not_open")
            return message.get("result") or {}

    def _send(self, payload: bytes) -> None:
        mask = os.urandom(4)
        header = bytearray([0x81])
        length = len(payload)
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.append(0x80 | 126)
            header += length.to_bytes(2, "big")
        else:
            header.append(0x80 | 127)
            header += length.to_bytes(8, "big")
        header += mask
        masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
        self._sock.sendall(bytes(header) + masked)

    def _recv(self) -> bytes:
        while True:
            frame = self._read_frame()
            opcode = frame[0]
            if opcode == 0x8:
                raise FillError("browser_not_open")
            if opcode == 0x9:
                self._pong(frame[1])
                continue
            if opcode == 0x1:
                return frame[1]

    def _pong(self, payload: bytes) -> None:
        header = bytearray([0x8A, 0x80 | len(payload)])
        mask = os.urandom(4)
        masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
        self._sock.sendall(bytes(header) + mask + masked)

    def _read_exact(self, size: int) -> bytes:
        while len(self._buf) < size:
            chunk = self._sock.recv(4096)
            if not chunk:
                raise FillError("browser_not_open")
            self._buf += chunk
        out = bytes(self._buf[:size])
        del self._buf[:size]
        return out

    def _read_frame(self) -> tuple:
        header = self._read_exact(2)
        opcode = header[0] & 0x0F
        masked = header[1] & 0x80
        length = header[1] & 0x7F
        if length == 126:
            length = int.from_bytes(self._read_exact(2), "big")
        elif length == 127:
            length = int.from_bytes(self._read_exact(8), "big")
        mask = self._read_exact(4) if masked else b""
        payload = self._read_exact(length) if length else b""
        if mask:
            payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
        return opcode, payload
