#!/usr/bin/env python3
"""One TigerVNC display per Agent, plus a localhost hold/release API.

The computer-wide desktop stays on :1. Each Agent gets its own display,
RFB port, Xauthority file, XDG directories, and session bus. The daemon
holds the screen for the life of the Agent process. A browser viewer
keeps it up too. With neither, the display stops after a short idle.
"""
import json
import os
import re
import secrets
import shlex
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
AGENT_ID = re.compile(r"^[A-Za-z0-9_-]+$")
SCREEN_PATH = re.compile(r"^/screen/([A-Za-z0-9_-]+)(?:/(.*))?$")
DISPLAY_BASE = 20
PORT_BASE = 6100
MAX_SCREENS = 40
CONTROL_HOST = "127.0.0.1"
CONTROL_PORT = int(os.environ.get("COFORGE_AGENT_SCREEN_PORT", "6091"))


def screen_target(path: str):
    """Map /screen/<agent>/<rest> to (agent id, 'page'|'socket'|static relative)."""
    match = SCREEN_PATH.fullmatch(path)
    if not match:
        return None
    agent_id, rest = match.group(1), match.group(2) or ""
    if rest in ("", "desktop.html"):
        return agent_id, "page"
    if rest == "websockify":
        return agent_id, "socket"
    parts = rest.split("/")
    if any(part in ("", ".", "..") for part in parts):
        return None
    return agent_id, rest


def _quote(value: str) -> str:
    return shlex.quote(value)


class AgentScreens:
    def __init__(
        self,
        root=None,
        launch=None,
        idle_seconds=None,
        bus_timeout=5.0,
        xstartup="/usr/local/share/coforge/vnc-agent-xstartup",
    ):
        self.root = root or os.environ.get(
            "COFORGE_AGENT_SCREEN_ROOT", "/root/.coforge/agent-screens"
        )
        self.launch = launch or self._launch
        self.idle_seconds = (
            float(os.environ.get("VNC_AGENT_IDLE_SECONDS", "60"))
            if idle_seconds is None
            else float(idle_seconds)
        )
        self.bus_timeout = bus_timeout
        self.xstartup = xstartup
        self._lock = threading.Lock()
        self._screens = {}
        self._starting = {}

    def lookup(self, agent_id: str):
        """The running screen's display, without holding it open."""
        if not AGENT_ID.fullmatch(agent_id or ""):
            return None
        with self._lock:
            screen = self._screens.get(agent_id)
            if screen is None or not self._alive(screen):
                return None
            return {"display": f":{screen['number']}"}

    def hold(self, agent_id: str) -> dict:
        screen = self._ensure(agent_id)
        with self._lock:
            screen["held"] = True
            self._cancel_idle(screen)
        return self._describe(screen)

    def release(self, agent_id: str) -> None:
        if not AGENT_ID.fullmatch(agent_id or ""):
            return
        with self._lock:
            screen = self._screens.get(agent_id)
            if screen is None:
                return
            screen["held"] = False
            if screen["viewers"] == 0:
                self._arm_idle(screen)

    def open_viewer(self, agent_id: str) -> int:
        screen = self._ensure(agent_id)
        with self._lock:
            screen["viewers"] += 1
            self._cancel_idle(screen)
            return screen["port"]

    def close_viewer(self, agent_id: str) -> None:
        with self._lock:
            screen = self._screens.get(agent_id)
            if screen is None:
                return
            screen["viewers"] = max(0, screen["viewers"] - 1)
            if screen["viewers"] == 0 and not screen["held"]:
                self._arm_idle(screen)

    def _ensure(self, agent_id: str) -> dict:
        if not AGENT_ID.fullmatch(agent_id or ""):
            raise ValueError("agent id")
        with self._lock:
            screen = self._screens.get(agent_id)
            if screen is not None and self._alive(screen):
                return screen
            if screen is not None and self._starting.get(agent_id) is None:
                self._stop_locked(screen)
            started = self._starting.get(agent_id)
            if started is None:
                self._starting[agent_id] = threading.Event()
                started = None
        if started is not None:
            started.wait(timeout=15)
            with self._lock:
                screen = self._screens.get(agent_id)
                if screen is not None and self._alive(screen):
                    return screen
            raise RuntimeError("agent screen did not start")
        screen = None
        try:
            with self._lock:
                number, port = self._allocate()
                directory = os.path.join(self.root, agent_id)
                screen = {
                    "agent_id": agent_id,
                    "number": number,
                    "port": port,
                    "directory": directory,
                    "process": None,
                    "viewers": 0,
                    "held": False,
                    "idle": None,
                }
                self._screens[agent_id] = screen
            os.makedirs(directory, mode=0o700, exist_ok=True)
            for name in ("config", "data", "cache", "runtime"):
                os.makedirs(os.path.join(directory, name), mode=0o700, exist_ok=True)
            process = self.launch(self._spec(screen))
            with self._lock:
                screen["process"] = process
            return screen
        except Exception:
            with self._lock:
                if screen is not None and self._screens.get(agent_id) is screen:
                    del self._screens[agent_id]
            raise
        finally:
            with self._lock:
                event = self._starting.pop(agent_id, None)
            if event is not None:
                event.set()

    def _cdp_token(self, directory: str) -> str:
        path = os.path.join(directory, "cdp.token")
        try:
            with open(path, encoding="utf-8") as handle:
                value = handle.read().strip()
            if re.fullmatch(r"[0-9a-f]{32}", value):
                return value
        except OSError:
            pass
        value = secrets.token_hex(16)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(value + "\n")
        os.chmod(path, 0o600)
        return value

    def _spec(self, screen: dict) -> dict:
        directory = screen["directory"]
        token = self._cdp_token(directory)
        env = {
            "COFORGE_SCREEN_DIR": directory,
            "COFORGE_CDP_TOKEN": token,
            "DISPLAY": f":{screen['number']}",
            "XAUTHORITY": os.path.join(directory, "Xauthority"),
            "XDG_CONFIG_HOME": os.path.join(directory, "config"),
            "XDG_DATA_HOME": os.path.join(directory, "data"),
            "XDG_CACHE_HOME": os.path.join(directory, "cache"),
            "XDG_RUNTIME_DIR": os.path.join(directory, "runtime"),
        }
        wrapper = os.path.join(directory, "xstartup")
        lines = ["#!/bin/sh", "set -eu"]
        for key, value in env.items():
            lines.append(f"export {key}={_quote(value)}")
        lines.append(f"exec {_quote(self.xstartup)}")
        with open(wrapper, "w", encoding="utf-8") as handle:
            handle.write("\n".join(lines) + "\n")
        os.chmod(wrapper, 0o755)
        # Keep Chromium profile token in sync when HOME is shared.
        home = os.environ.get("HOME", "/root")
        profile = os.path.join(
            home, ".config", "coforge-chromium", str(screen["number"])
        )
        os.makedirs(profile, mode=0o700, exist_ok=True)
        profile_token = os.path.join(profile, "cdp.token")
        with open(profile_token, "w", encoding="utf-8") as handle:
            handle.write(token + "\n")
        os.chmod(profile_token, 0o600)
        return {
            "display": env["DISPLAY"],
            "port": screen["port"],
            "directory": directory,
            "xstartup": wrapper,
            "env": env,
        }

    def _describe(self, screen: dict) -> dict:
        env = self._spec(screen)["env"]
        bus_path = os.path.join(screen["directory"], "bus")
        display = env["DISPLAY"]
        number = screen["number"]
        return {
            "display": display,
            "xauthority": env["XAUTHORITY"],
            "configHome": env["XDG_CONFIG_HOME"],
            "dataHome": env["XDG_DATA_HOME"],
            "cacheHome": env["XDG_CACHE_HOME"],
            "runtimeDir": env["XDG_RUNTIME_DIR"],
            "dbus": self._read_bus(bus_path),
            # Optional for Computer binaries that forward unknown hold fields:
            "cdpToken": env["COFORGE_CDP_TOKEN"],
            "cdpPort": 9222 + number,
            "cdpEndpoint": (
                f"http://127.0.0.1:{9222 + number}/coforge-cdp/"
                f"{env['COFORGE_CDP_TOKEN']}/"
            ),
        }
    def _read_bus(self, path: str) -> str:
        deadline = time.time() + self.bus_timeout
        while True:
            try:
                with open(path, encoding="utf-8") as handle:
                    value = handle.read().strip()
                if value and "\n" not in value:
                    return value
            except OSError:
                pass
            if time.time() >= deadline:
                return ""
            time.sleep(0.05)

    def _allocate(self):
        used = {screen["number"] for screen in self._screens.values()}
        for offset in range(MAX_SCREENS):
            number = DISPLAY_BASE + offset
            if number in used:
                continue
            if os.path.exists(f"/tmp/.X{number}-lock"):
                continue
            return number, PORT_BASE + offset
        raise RuntimeError("no free agent display")

    def _alive(self, screen: dict) -> bool:
        process = screen["process"]
        if process is None:
            return False
        return process.poll() is None

    def _cancel_idle(self, screen: dict) -> None:
        timer = screen.get("idle")
        if timer is not None:
            timer.cancel()
            screen["idle"] = None

    def _arm_idle(self, screen: dict) -> None:
        self._cancel_idle(screen)
        agent_id = screen["agent_id"]

        def fire() -> None:
            with self._lock:
                current = self._screens.get(agent_id)
                if current is not screen:
                    return
                if current["held"] or current["viewers"] > 0:
                    return
                self._stop_locked(current)

        timer = threading.Timer(self.idle_seconds, fire)
        timer.daemon = True
        screen["idle"] = timer
        timer.start()

    def _stop_locked(self, screen: dict) -> None:
        self._cancel_idle(screen)
        process = screen["process"]
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
        display = f":{screen['number']}"
        try:
            subprocess.run(
                ["tigervncserver", "-kill", display],
                check=False,
                capture_output=True,
            )
        except OSError:
            pass
        for path in (
            f"/tmp/.X{screen['number']}-lock",
            f"/tmp/.X11-unix/X{screen['number']}",
        ):
            try:
                os.remove(path)
            except OSError:
                pass
        self._screens.pop(screen["agent_id"], None)

    def _launch(self, spec: dict):
        self._write_password()
        env = os.environ.copy()
        env.update(spec["env"])
        process = subprocess.Popen(
            [
                "tigervncserver",
                spec["display"],
                "-fg",
                "-geometry",
                os.environ.get("VNC_GEOMETRY", "1920x1080"),
                "-depth",
                "24",
                "-rfbport",
                str(spec["port"]),
                "-localhost",
                "yes",
                "-rfbauth",
                "/root/.vnc/passwd",
                "-xstartup",
                spec["xstartup"],
                "-SecurityTypes",
                "VncAuth",
                "-alwaysshared",
            ],
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        deadline = time.time() + 10
        while time.time() < deadline:
            if _port_open(spec["port"]):
                return process
            if process.poll() is not None:
                err = process.stderr.read().decode("utf-8", "replace") if process.stderr else ""
                raise RuntimeError(err.strip() or "tigervncserver exited")
            time.sleep(0.1)
        process.terminate()
        raise RuntimeError(f"agent display {spec['display']} did not listen")

    def _write_password(self) -> None:
        if os.path.isfile("/root/.vnc/passwd"):
            return
        sibling = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vnc-ondemand.py")
        import importlib.util

        spec = importlib.util.spec_from_file_location("vnc_ondemand", sibling)
        if spec is None or spec.loader is None:
            raise RuntimeError("vnc-ondemand.py is missing")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.write_password()


def _port_open(port: int) -> bool:
    import socket

    try:
        with socket.create_connection(("127.0.0.1", port), 0.2):
            return True
    except OSError:
        return False


def serve_control(screens: AgentScreens, host=CONTROL_HOST, port=CONTROL_PORT):
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            path = urlsplit(self.path).path
            match = re.fullmatch(r"/screen/([A-Za-z0-9_-]+)(/release)?", path)
            if not match:
                self.send_error(404)
                return
            agent_id, releasing = match.group(1), match.group(2)
            if releasing:
                screens.release(agent_id)
                body = b"{}\n"
            else:
                try:
                    body = (json.dumps(screens.hold(agent_id)) + "\n").encode()
                except ValueError:
                    self.send_error(400)
                    return
                except Exception as exc:
                    body = json.dumps({"error": str(exc)}).encode()
                    self.send_response(500)
                    self._send(body)
                    return
            self.send_response(200)
            self._send(body)

        def _send(self, body: bytes) -> None:
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, fmt, *args):
            return

    server = ThreadingHTTPServer((host, port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def main() -> None:
    screens = AgentScreens()
    server = serve_control(screens)
    print(f"[vnc-screen] listening on {CONTROL_HOST}:{CONTROL_PORT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
