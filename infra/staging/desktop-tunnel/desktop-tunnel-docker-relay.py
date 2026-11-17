#!/usr/bin/env python3
"""Relay ECS private IP:16090 → SSH reverse-tunnel loopback 127.0.0.1:16090.

Compose Caddy cannot dial the host's loopback or docker0 bridge gateway. It can
reach the ECS primary private address, so this process listens there and
forwards to the loopback-bound reverse tunnel.
"""

from __future__ import annotations

import os
import select
import socket
import subprocess
import sys


def detect_private_ip() -> str:
    override = os.environ.get("RELAY_LISTEN_HOST", "").strip()
    if override:
        return override
    out = subprocess.check_output(
        ["ip", "-4", "route", "get", "1.1.1.1"],
        text=True,
    )
    parts = out.split()
    try:
        return parts[parts.index("src") + 1]
    except (ValueError, IndexError) as exc:
        raise SystemExit("could not detect RELAY_LISTEN_HOST; set it explicitly") from exc


LISTEN_HOST = detect_private_ip()
LISTEN_PORT = int(os.environ.get("RELAY_LISTEN_PORT", "16090"))
TARGET = (
    os.environ.get("RELAY_TARGET_HOST", "127.0.0.1"),
    int(os.environ.get("RELAY_TARGET_PORT", "16090")),
)


def pipe(a: socket.socket, b: socket.socket) -> None:
    sockets = [a, b]
    while True:
        readable, _, errored = select.select(sockets, [], sockets, 60)
        if errored:
            break
        if not readable:
            continue
        for src in readable:
            data = src.recv(65536)
            if not data:
                return
            (b if src is a else a).sendall(data)


def main() -> int:
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((LISTEN_HOST, LISTEN_PORT))
    srv.listen(128)
    print(
        f"relay listening on {LISTEN_HOST}:{LISTEN_PORT} -> {TARGET[0]}:{TARGET[1]}",
        flush=True,
    )
    while True:
        client, _addr = srv.accept()
        try:
            upstream = socket.create_connection(TARGET, timeout=5)
        except OSError as exc:
            print(f"upstream connect failed: {exc}", file=sys.stderr, flush=True)
            client.close()
            continue
        pid = os.fork()
        if pid == 0:
            srv.close()
            try:
                pipe(client, upstream)
            finally:
                client.close()
                upstream.close()
            os._exit(0)
        client.close()
        upstream.close()
        os.waitpid(pid, os.WNOHANG)


if __name__ == "__main__":
    raise SystemExit(main())
