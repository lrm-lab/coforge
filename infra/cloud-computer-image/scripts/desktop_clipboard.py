"""Set and read the X CLIPBOARD selection as UTF-8 for the cloud desktop.

TigerVNC 1.12 advertises extended clipboard but never completes the
Notify/Request/Provide round-trip from a viewer, and classic ClientCutText is
Latin-1 only. This owner process holds UTF-8 on CLIPBOARD until replaced.
"""

from __future__ import annotations

import os
import signal
import sys
import time
from pathlib import Path

MAX_CLIPBOARD_BYTES = 65536


class ClipboardError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _state_paths(display_name: str) -> tuple[Path, Path]:
    safe = display_name.replace(":", "_").replace("/", "_")
    base = Path(os.environ.get("XDG_RUNTIME_DIR", "/tmp"))
    return base / f"coforge-clipboard{safe}.pid", base / f"coforge-clipboard{safe}.bin"


def _pid_running(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    try:
        with open(f"/proc/{pid}/status", encoding="utf-8") as handle:
            for line in handle:
                if line.startswith("State:"):
                    return not line.split()[1].startswith("Z")
    except OSError:
        return False
    return True


def _require_xlib() -> None:
    try:
        import Xlib  # noqa: F401
    except ImportError as exc:
        raise ClipboardError("xlib_missing") from exc


def _require_display(display_name: str) -> None:
    if not display_name.startswith(":"):
        raise ClipboardError("bad_display")
    socket_path = Path("/tmp/.X11-unix") / f"X{display_name[1:]}"
    if not socket_path.exists():
        raise ClipboardError("display_down")


def _serve(display_name: str, payload: bytes, xauthority: str | None) -> None:
    from Xlib import X, Xatom, display
    from Xlib.protocol import event

    os.environ["DISPLAY"] = display_name
    if xauthority:
        os.environ["XAUTHORITY"] = xauthority
    d = display.Display()
    root = d.screen().root
    clipboard = d.intern_atom("CLIPBOARD")
    utf8 = d.intern_atom("UTF8_STRING")
    targets = d.intern_atom("TARGETS")
    win = root.create_window(0, 0, 1, 1, 0, d.screen().root_depth)
    win.set_selection_owner(clipboard, X.CurrentTime)
    d.flush()
    if d.get_selection_owner(clipboard).id != win.id:
        raise ClipboardError("clipboard_busy")
    while True:
        ev = d.next_event()
        if ev.type == X.SelectionClear and ev.atom == clipboard:
            return
        if ev.type != X.SelectionRequest or ev.owner.id != win.id:
            continue
        target = ev.target
        prop = ev.property if ev.property != X.NONE else target
        ret_prop = prop
        if target == targets:
            ev.requestor.change_property(prop, Xatom.ATOM, 32, [utf8, Xatom.STRING])
        elif target == utf8:
            ev.requestor.change_property(prop, utf8, 8, list(payload))
        elif target == Xatom.STRING:
            # Latin-1 STRING cannot carry arbitrary UTF-8; refuse rather than mojibake.
            ret_prop = X.NONE
        else:
            ret_prop = X.NONE
        ev.requestor.send_event(
            event.SelectionNotify(
                time=ev.time,
                requestor=ev.requestor,
                selection=ev.selection,
                target=ev.target,
                property=ret_prop,
            )
        )
        d.flush()


def set_clipboard(display_name: str, text: str, xauthority: str | None = None) -> None:
    raw = text.encode("utf-8")
    if len(raw) == 0:
        raise ClipboardError("empty")
    if len(raw) > MAX_CLIPBOARD_BYTES:
        raise ClipboardError("too_large")
    _require_display(display_name)
    _require_xlib()
    auth = xauthority or os.environ.get("XAUTHORITY") or "/root/.Xauthority"
    pid_path, bin_path = _state_paths(display_name)
    bin_path.write_bytes(raw)
    old = ""
    try:
        old = pid_path.read_text(encoding="utf-8").strip()
    except OSError:
        old = ""
    if old.isdigit():
        try:
            os.kill(int(old), signal.SIGTERM)
        except OSError:
            pass
        for _ in range(20):
            if not _pid_running(int(old)):
                break
            time.sleep(0.05)
    script = Path(__file__).resolve()
    pid = os.spawnv(
        os.P_NOWAIT,
        sys.executable,
        [sys.executable, str(script), "--serve", display_name, str(bin_path), auth],
    )
    pid_path.write_text(f"{pid}\n", encoding="utf-8")
    for _ in range(40):
        if not _pid_running(pid):
            break
        try:
            if get_clipboard(display_name, xauthority=auth) == text:
                return
        except ClipboardError:
            pass
        time.sleep(0.05)
    if not _pid_running(pid):
        raise ClipboardError("owner_failed")
    raise ClipboardError("owner_failed")


def _property_bytes(value: object) -> bytes:
    if isinstance(value, (bytes, bytearray)):
        return bytes(value)
    if isinstance(value, str):
        return value.encode("latin-1", "surrogateescape")
    return bytes(value)


def _decode_clipboard(raw: bytes, target_kind: str) -> str:
    if target_kind == "utf8":
        return raw.decode("utf-8")
    try:
        return raw.decode("utf-8")
    except UnicodeError:
        return raw.decode("latin-1")


def get_clipboard(display_name: str, xauthority: str | None = None) -> str:
    _require_display(display_name)
    _require_xlib()
    from Xlib import X, Xatom, display

    auth = xauthority or os.environ.get("XAUTHORITY") or "/root/.Xauthority"
    os.environ["DISPLAY"] = display_name
    os.environ["XAUTHORITY"] = auth
    last_error = "empty"
    for _ in range(8):
        d = display.Display()
        try:
            root = d.screen().root
            clipboard = d.intern_atom("CLIPBOARD")
            utf8 = d.intern_atom("UTF8_STRING")
            prop = d.intern_atom("COFORGE_CLIPBOARD_READ")
            win = root.create_window(0, 0, 1, 1, 0, d.screen().root_depth)
            for target, kind in ((utf8, "utf8"), (Xatom.STRING, "string")):
                win.convert_selection(clipboard, target, prop, X.CurrentTime)
                d.flush()
                deadline = time.time() + 1
                got_notify = False
                while time.time() < deadline:
                    ev = d.next_event()
                    if ev.type != X.SelectionNotify:
                        continue
                    got_notify = True
                    if ev.property == X.NONE:
                        last_error = "empty"
                        break
                    data = win.get_full_property(prop, X.AnyPropertyType)
                    if data is None:
                        last_error = "read_failed"
                        break
                    raw = _property_bytes(data.value)
                    try:
                        text = _decode_clipboard(raw, kind)
                    except UnicodeError as exc:
                        raise ClipboardError("not_utf8") from exc
                    if len(raw) > MAX_CLIPBOARD_BYTES:
                        raise ClipboardError("too_large")
                    if len(text) == 0:
                        last_error = "empty"
                        break
                    return text
                if not got_notify:
                    last_error = "read_timeout"
        finally:
            d.close()
        time.sleep(0.05)
    raise ClipboardError(last_error)


def main(argv: list[str]) -> int:
    if len(argv) >= 2 and argv[1] == "--serve":
        display_name = argv[2]
        payload = Path(argv[3]).read_bytes()
        auth = argv[4] if len(argv) > 4 else None
        try:
            _serve(display_name, payload, auth)
        except Exception:
            return 1
        return 0
    print("usage: desktop_clipboard.py --serve DISPLAY PATH [XAUTHORITY]", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
