#!/usr/bin/env python3
"""Shared-desktop ondemand helpers: RFB health and restart-when-unhealthy."""
import os
import socket
import threading
import unittest
from importlib.machinery import SourceFileLoader

HERE = os.path.dirname(os.path.abspath(__file__))
ondemand = SourceFileLoader(
    "vnc_ondemand", os.path.join(HERE, "vnc-ondemand.py")
).load_module()


def _serve_once(payload: bytes) -> int:
    listener = socket.socket()
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    port = listener.getsockname()[1]

    def run() -> None:
        client, _addr = listener.accept()
        try:
            if payload:
                client.sendall(payload)
            client.recv(64)
        finally:
            client.close()
            listener.close()

    threading.Thread(target=run, daemon=True).start()
    return port


class VncOndemandTest(unittest.TestCase):
    def test_backend_ready_accepts_rfb_banner(self):
        port = _serve_once(b"RFB 003.008\n")
        self.assertTrue(ondemand.backend_ready(port))

    def test_backend_ready_rejects_non_rfb(self):
        port = _serve_once(b"HTTP/1.1 200 OK\r\n")
        self.assertFalse(ondemand.backend_ready(port))

    def test_backend_ready_rejects_closed_port(self):
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
        listener.close()
        self.assertFalse(ondemand.backend_ready(port))

    def test_start_server_restarts_when_port_open_but_unhealthy(self):
        calls: list[str] = []

        def fake_port_open(port: int) -> bool:
            return True

        def fake_ready(port: int) -> bool:
            return False

        def fake_stop() -> None:
            calls.append("stop")

        def fake_launch() -> None:
            calls.append("launch")

        ondemand.ensure_desktop(
            port_open=fake_port_open,
            backend_ready=fake_ready,
            stop_server=fake_stop,
            launch_server=fake_launch,
        )
        self.assertEqual(calls, ["stop", "launch"])

    def test_start_server_skips_launch_when_healthy(self):
        calls: list[str] = []
        ondemand.ensure_desktop(
            port_open=lambda _port: True,
            backend_ready=lambda _port: True,
            stop_server=lambda: calls.append("stop"),
            launch_server=lambda: calls.append("launch"),
        )
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
