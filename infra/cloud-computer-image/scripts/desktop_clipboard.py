"""Set the X CLIPBOARD selection to UTF-8 text for the cloud desktop.

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
        elif target in (utf8, Xatom.STRING):
            ev.requestor.change_property(prop, target, 8, list(payload))
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
    if not display_name.startswith(":"):
        raise ClipboardError("bad_display")
    raw = text.encode("utf-8")
    if len(raw) == 0:
        raise ClipboardError("empty")
    if len(raw) > MAX_CLIPBOARD_BYTES:
        raise ClipboardError("too_large")
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
            try:
                os.kill(int(old), 0)
            except OSError:
                break
            time.sleep(0.05)
    script = Path(__file__).resolve()
    pid = os.spawnv(
        os.P_NOWAIT,
        sys.executable,
        [sys.executable, str(script), "--serve", display_name, str(bin_path), auth],
    )
    pid_path.write_text(f"{pid}\n", encoding="utf-8")
    time.sleep(0.05)
    try:
        os.kill(pid, 0)
    except OSError as exc:
        raise ClipboardError("owner_failed") from exc


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
