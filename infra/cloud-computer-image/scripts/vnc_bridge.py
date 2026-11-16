"""VNC RFB login and WebSocket bridge for the desktop viewer."""
import os
import socket
import threading

from vnc_des import vnc_response

VNC_HOST = "127.0.0.1"
VNC_PORT = int(os.environ.get("VNC_PORT", "5901"))
MAX_FRAME = 8 * 1024 * 1024


def read_exact(sock: socket.socket, size: int) -> bytes:
    buf = bytearray()
    while len(buf) < size:
        chunk = sock.recv(size - len(buf))
        if not chunk:
            raise ConnectionError("connection closed")
        buf += chunk
    return bytes(buf)


def load_password() -> str:
    password = os.environ.get("VNC_PASSWORD", "").strip()
    if password:
        return password
    for _ in range(100):
        try:
            with open("/root/.vnc/password.txt", encoding="utf-8") as handle:
                password = handle.read().strip()
        except OSError:
            password = ""
        if password:
            return password
        threading.Event().wait(0.1)
    raise ConnectionError("VNC password is not ready")


def login_to_vnc(sock: socket.socket, password: str) -> None:
    banner = read_exact(sock, 12)
    if not banner.startswith(b"RFB "):
        raise ConnectionError("desktop did not speak VNC")
    sock.sendall(b"RFB 003.008\n")
    count = read_exact(sock, 1)[0]
    if count == 0:
        length = int.from_bytes(read_exact(sock, 4), "big")
        reason = read_exact(sock, min(length, 512)).decode("utf-8", "replace")
        raise ConnectionError(reason or "desktop rejected the session")
    types = read_exact(sock, count)
    if 2 not in types:
        raise ConnectionError("desktop has no password login")
    sock.sendall(bytes([2]))
    challenge = read_exact(sock, 16)
    sock.sendall(vnc_response(challenge, password))
    result = int.from_bytes(read_exact(sock, 4), "big")
    if result != 0:
        raise ConnectionError("VNC login failed")


class Stream:
    def __init__(self, sock: socket.socket) -> None:
        self.sock = sock
        self.buf = bytearray()
        self.lock = threading.Lock()

    def read(self, size: int) -> bytes:
        while len(self.buf) < size:
            opcode, payload = read_frame(self.sock)
            if opcode == 0x8:
                raise ConnectionError("browser closed")
            if opcode == 0x9:
                send_frame(self.sock, 0xA, payload, self.lock)
                continue
            if opcode == 0xA:
                continue
            if opcode in (0x1, 0x2):
                self.buf += payload
        out = bytes(self.buf[:size])
        del self.buf[:size]
        return out

    def write(self, payload: bytes) -> None:
        send_frame(self.sock, 0x2, payload, self.lock)


def read_frame(sock: socket.socket) -> tuple[int, bytes]:
    opcode = None
    parts = []
    while True:
        header = read_exact(sock, 2)
        fin = header[0] & 0x80
        op = header[0] & 0x0F
        masked = header[1] & 0x80
        length = header[1] & 0x7F
        if length == 126:
            length = int.from_bytes(read_exact(sock, 2), "big")
        elif length == 127:
            length = int.from_bytes(read_exact(sock, 8), "big")
        if length > MAX_FRAME:
            raise ConnectionError("websocket frame too large")
        mask = read_exact(sock, 4) if masked else b""
        payload = read_exact(sock, length) if length else b""
        if mask:
            payload = bytes(byte ^ mask[i % 4] for i, byte in enumerate(payload))
        if op in (0x8, 0x9, 0xA):
            return op, payload
        if op == 0:
            if opcode is None:
                raise ConnectionError("broken websocket frame")
        else:
            opcode = op
        parts.append(payload)
        if fin:
            return opcode or 0x2, b"".join(parts)


def send_frame(sock: socket.socket, opcode: int, payload: bytes, lock: threading.Lock) -> None:
    header = bytearray([0x80 | opcode])
    length = len(payload)
    if length < 126:
        header.append(length)
    elif length < 65536:
        header.append(126)
        header += length.to_bytes(2, "big")
    else:
        header.append(127)
        header += length.to_bytes(8, "big")
    with lock:
        sock.sendall(bytes(header) + payload)


def accept_browser(stream: Stream) -> bytes:
    stream.write(b"RFB 003.008\n")
    version = stream.read(12)
    if not version.startswith(b"RFB "):
        raise ConnectionError("browser did not speak VNC")
    stream.write(bytes([1, 1]))
    if stream.read(1) != b"\x01":
        raise ConnectionError("browser rejected the desktop session")
    stream.write(b"\x00\x00\x00\x00")
    return stream.read(1)


def pump_desktop(vnc: socket.socket, stream: Stream) -> None:
    def outward() -> None:
        try:
            while True:
                data = vnc.recv(65536)
                if not data:
                    break
                stream.write(data)
        except OSError:
            pass
        finally:
            try:
                stream.sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    threading.Thread(target=outward, daemon=True).start()
    try:
        while True:
            opcode, payload = read_frame(stream.sock)
            if opcode == 0x8:
                break
            if opcode == 0x9:
                send_frame(stream.sock, 0xA, payload, stream.lock)
                continue
            if opcode in (0x1, 0x2) and payload:
                vnc.sendall(payload)
    finally:
        vnc.close()


def bridge(conn: socket.socket, vnc_port: int = VNC_PORT) -> None:
    vnc = socket.create_connection((VNC_HOST, vnc_port), 10)
    # The connect timeout stays on the socket. A still desktop sends no bytes,
    # so the next recv would fail after 10s and drop the browser session.
    vnc.settimeout(None)
    vnc.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    try:
        login_to_vnc(vnc, load_password())
        stream = Stream(conn)
        client_init = accept_browser(stream)
        vnc.sendall(client_init)
        if stream.buf:
            vnc.sendall(stream.buf)
            stream.buf.clear()
        pump_desktop(vnc, stream)
    finally:
        vnc.close()


class BufferedSocket:
    def __init__(self, sock: socket.socket, pending: bytes) -> None:
        self.sock = sock
        self.buf = bytearray(pending)

    def recv(self, size: int) -> bytes:
        if self.buf:
            out = bytes(self.buf[:size])
            del self.buf[:size]
            return out
        return self.sock.recv(size)

    def sendall(self, payload: bytes) -> None:
        self.sock.sendall(payload)

    def close(self) -> None:
        self.sock.close()

    def shutdown(self, how: int) -> None:
        self.sock.shutdown(how)
