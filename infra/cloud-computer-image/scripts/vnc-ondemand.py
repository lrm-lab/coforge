#!/usr/bin/env python3
"""Accept VNC on VNC_PORT with a shared desktop that stays up for the container.

The shared desktop starts when this process starts. Opening the browser only
connects to it. Set VNC_IDLE_SECONDS to a positive number to restore the old
idle shutdown (for experiments); the default 0 keeps the desktop up.
"""
import importlib.util
import os
import secrets
import select
import socket
import subprocess
import threading
import time

LISTEN_PORT = int(os.environ.get("VNC_PORT", "5901"))
BACKEND_PORT = int(os.environ.get("VNC_BACKEND_PORT", "5991"))
IDLE_SECONDS = int(os.environ.get("VNC_IDLE_SECONDS", "0"))
GEOMETRY = os.environ.get("VNC_GEOMETRY", "1920x1080")
DISPLAY = os.environ.get("VNC_DISPLAY", ":1")

clients = 0
last_used = time.time()
server = None
lock = threading.Lock()


def log(message: str) -> None:
    print(f"[vnc] {message}", flush=True)


def idle_shutdown_enabled() -> bool:
    return IDLE_SECONDS > 0


def write_password() -> None:
    """Keep one VNC password for the life of the container.

    The shared desktop and every Agent screen read the same files. Generating a
    new password each time the shared desktop starts leaves already-running
    Agent screens on the old one, and the browser then waits forever.
    """
    os.makedirs("/root/.vnc", mode=0o700, exist_ok=True)
    path = "/root/.vnc/password.txt"
    password = os.environ.get("VNC_PASSWORD", "").strip()
    if not password:
        try:
            with open(path, encoding="utf-8") as handle:
                password = handle.read().strip()
        except OSError:
            password = ""
    if not password:
        password = secrets.token_hex(4)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(password + "\n")
        os.chmod(path, 0o600)
        log("VNC_PASSWORD is unset; a password was written to /root/.vnc/password.txt")
    # Bookworm's TigerVNC packages ship the server without tigervncpasswd.
    sibling = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vnc-websocket.py")
    spec = importlib.util.spec_from_file_location("vnc_websocket", sibling)
    if spec is None or spec.loader is None:
        raise RuntimeError("vnc-websocket.py is missing")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    encoded = module.obfuscate_vnc_password(password)
    passwd_path = "/root/.vnc/passwd"
    try:
        with open(passwd_path, "rb") as handle:
            current = handle.read()
    except OSError:
        current = b""
    if current == encoded:
        return
    with open(passwd_path, "wb") as handle:
        handle.write(encoded)
    os.chmod(passwd_path, 0o600)


def port_open(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), 0.2):
            return True
    except OSError:
        return False


def backend_ready(port: int) -> bool:
    """True when the backend speaks RFB, not merely when the TCP port is open."""
    try:
        with socket.create_connection(("127.0.0.1", port), 0.5) as sock:
            sock.settimeout(0.5)
            banner = sock.recv(12)
    except OSError:
        return False
    return banner.startswith(b"RFB ")


def stop_server() -> None:
    global server
    if server is not None and server.poll() is None:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()
    server = None
    subprocess.run(["tigervncserver", "-kill", DISPLAY], check=False, capture_output=True)
    subprocess.run(["pkill", "-f", f"Xtigervnc {DISPLAY}"], check=False)
    for path in (f"/tmp/.X{DISPLAY[1:]}-lock", f"/tmp/.X11-unix/X{DISPLAY[1:]}"):
        try:
            os.remove(path)
        except OSError:
            pass


def launch_server() -> None:
    global server
    write_password()
    xstartup = "/usr/local/share/coforge/vnc-xstartup"
    if not os.path.exists("/root/.vnc/xstartup"):
        os.makedirs("/root/.vnc", mode=0o700, exist_ok=True)
        os.symlink(xstartup, "/root/.vnc/xstartup")
    server = subprocess.Popen(
        [
            "tigervncserver",
            DISPLAY,
            "-fg",
            "-geometry",
            GEOMETRY,
            "-depth",
            "24",
            "-rfbport",
            str(BACKEND_PORT),
            "-localhost",
            "yes",
            "-rfbauth",
            "/root/.vnc/passwd",
            "-xstartup",
            xstartup,
            "-SecurityTypes",
            "VncAuth",
            "-alwaysshared",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    for _ in range(100):
        if port_open(BACKEND_PORT):
            log(f"desktop started on 127.0.0.1:{BACKEND_PORT}")
            return
        if server.poll() is not None:
            err = server.stderr.read().decode("utf-8", "replace") if server.stderr else ""
            raise RuntimeError(err.strip() or "tigervncserver exited")
        time.sleep(0.1)
    stop_server()
    raise RuntimeError("TigerVNC did not open the backend port")


def ensure_desktop(
    *,
    port_open=port_open,
    backend_ready=backend_ready,
    stop_server=stop_server,
    launch_server=launch_server,
) -> None:
    """Start TigerVNC, or replace a listener that no longer speaks RFB."""
    if port_open(BACKEND_PORT):
        if backend_ready(BACKEND_PORT):
            return
        log("desktop port open but RFB unhealthy; restarting")
        stop_server()
    launch_server()


def start_server() -> None:
    ensure_desktop()


def prepare_shared_desktop(*, start_server=start_server) -> None:
    """Bring the shared desktop up at process start (always-on)."""
    with lock:
        start_server()


def consider_idle_stop(
    *,
    clients: int,
    last_used: float,
    now: float,
    port_open=port_open,
    stop_server=stop_server,
) -> bool:
    """Stop the desktop after idle only when VNC_IDLE_SECONDS is positive."""
    if not idle_shutdown_enabled():
        return False
    if clients != 0 or now - last_used < IDLE_SECONDS:
        return False
    if not port_open(BACKEND_PORT):
        return False
    log(f"no clients for {IDLE_SECONDS}s, stopping desktop")
    stop_server()
    return True


def splice(left: socket.socket, right: socket.socket) -> None:
    """Copy until either side closes. Never block forever on a full send buffer.

    A framebuffer update can stall sendall() while the peer receive window is
    full. That thread then misses the browser hangup and leaves the sockets
    half-open.
    """
    sockets = [left, right]
    pending: dict[socket.socket, bytes] = {left: b"", right: b""}
    for item in sockets:
        item.setblocking(False)
    try:
        while True:
            want_write = [item for item in sockets if pending[item]]
            readable, writable, exceptional = select.select(sockets, want_write, sockets, 60)
            if exceptional:
                return
            if not readable and not writable:
                continue

            for source in readable:
                target = right if source is left else left
                try:
                    data = source.recv(65536)
                except BlockingIOError:
                    continue
                except OSError:
                    return
                if not data:
                    return
                pending[target] += data

            for target in writable:
                blob = pending[target]
                if not blob:
                    continue
                try:
                    sent = target.send(blob)
                except BlockingIOError:
                    continue
                except OSError:
                    return
                if sent == 0:
                    return
                pending[target] = blob[sent:]
    finally:
        for item in sockets:
            try:
                item.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                item.close()
            except OSError:
                pass


def handle(client: socket.socket) -> None:
    global clients, last_used
    backend = None
    try:
        with lock:
            clients += 1
            start_server()
        backend = socket.create_connection(("127.0.0.1", BACKEND_PORT), 5)
        backend.settimeout(None)
        splice(client, backend)
    except Exception as exc:
        log(f"session failed: {exc}")
        try:
            client.close()
        except OSError:
            pass
    finally:
        with lock:
            clients = max(0, clients - 1)
            last_used = time.time()


def idle_loop() -> None:
    while True:
        time.sleep(5)
        with lock:
            consider_idle_stop(
                clients=clients,
                last_used=last_used,
                now=time.time(),
            )


def main() -> None:
    prepare_shared_desktop()
    if idle_shutdown_enabled():
        threading.Thread(target=idle_loop, daemon=True).start()
    listener = socket.socket()
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("0.0.0.0", LISTEN_PORT))
    listener.listen(8)
    log(f"listening on :{LISTEN_PORT}; shared desktop stays up")
    while True:
        client, _addr = listener.accept()
        threading.Thread(target=handle, args=(client,), daemon=True).start()


if __name__ == "__main__":
    main()
