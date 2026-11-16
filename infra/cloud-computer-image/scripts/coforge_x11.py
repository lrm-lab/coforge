"""Small X11 helpers for CoForge desktop launchers."""
from __future__ import annotations

import ctypes
import json
import os
from typing import Sequence


class Display(ctypes.Structure):
    pass


class XClientMessageEvent(ctypes.Structure):
    _fields_ = [
        ("type", ctypes.c_int),
        ("serial", ctypes.c_ulong),
        ("send_event", ctypes.c_int),
        ("display", ctypes.c_void_p),
        ("window", ctypes.c_ulong),
        ("message_type", ctypes.c_ulong),
        ("format", ctypes.c_int),
        ("data0", ctypes.c_long),
        ("data1", ctypes.c_long),
        ("data2", ctypes.c_long),
        ("data3", ctypes.c_long),
        ("data4", ctypes.c_long),
    ]


class XEvent(ctypes.Union):
    _fields_ = [("client", XClientMessageEvent), ("pad", ctypes.c_long * 24)]


X11 = ctypes.CDLL("libX11.so.6")
X11.XOpenDisplay.argtypes = [ctypes.c_char_p]
X11.XOpenDisplay.restype = ctypes.POINTER(Display)
X11.XDefaultRootWindow.argtypes = [ctypes.POINTER(Display)]
X11.XDefaultRootWindow.restype = ctypes.c_ulong
X11.XInternAtom.argtypes = [ctypes.POINTER(Display), ctypes.c_char_p, ctypes.c_int]
X11.XInternAtom.restype = ctypes.c_ulong
X11.XGetWindowProperty.argtypes = [
    ctypes.POINTER(Display),
    ctypes.c_ulong,
    ctypes.c_ulong,
    ctypes.c_long,
    ctypes.c_long,
    ctypes.c_int,
    ctypes.c_ulong,
    ctypes.POINTER(ctypes.c_ulong),
    ctypes.POINTER(ctypes.c_int),
    ctypes.POINTER(ctypes.c_ulong),
    ctypes.POINTER(ctypes.c_ulong),
    ctypes.POINTER(ctypes.c_void_p),
]
X11.XFree.argtypes = [ctypes.c_void_p]
X11.XSendEvent.argtypes = [
    ctypes.POINTER(Display),
    ctypes.c_ulong,
    ctypes.c_int,
    ctypes.c_long,
    ctypes.c_void_p,
]
X11.XFlush.argtypes = [ctypes.POINTER(Display)]
X11.XDefaultScreen.argtypes = [ctypes.POINTER(Display)]
X11.XDefaultScreen.restype = ctypes.c_int
X11.XIconifyWindow.argtypes = [ctypes.POINTER(Display), ctypes.c_ulong, ctypes.c_int]
X11.XIconifyWindow.restype = ctypes.c_int
X11.XMapWindow.argtypes = [ctypes.POINTER(Display), ctypes.c_ulong]
X11.XMapWindow.restype = ctypes.c_int
X11.XRaiseWindow.argtypes = [ctypes.POINTER(Display), ctypes.c_ulong]
X11.XRaiseWindow.restype = ctypes.c_int
X11.XGetGeometry.argtypes = [
    ctypes.POINTER(Display),
    ctypes.c_ulong,
    ctypes.POINTER(ctypes.c_ulong),
    ctypes.POINTER(ctypes.c_int),
    ctypes.POINTER(ctypes.c_int),
    ctypes.POINTER(ctypes.c_uint),
    ctypes.POINTER(ctypes.c_uint),
    ctypes.POINTER(ctypes.c_uint),
    ctypes.POINTER(ctypes.c_uint),
]
X11.XGetGeometry.restype = ctypes.c_int
X11.XTranslateCoordinates.argtypes = [
    ctypes.POINTER(Display),
    ctypes.c_ulong,
    ctypes.c_ulong,
    ctypes.c_int,
    ctypes.c_int,
    ctypes.POINTER(ctypes.c_int),
    ctypes.POINTER(ctypes.c_int),
    ctypes.POINTER(ctypes.c_ulong),
]
X11.XTranslateCoordinates.restype = ctypes.c_int
IconicState = 3
# EWMH _NET_WM_STATE actions
NetWmStateRemove = 0
NetWmStateAdd = 1
NetWmStateToggle = 2


def open_display() -> ctypes.POINTER(Display) | None:
    name = os.environ.get("DISPLAY", ":1").encode()
    return X11.XOpenDisplay(name)


def mru_store_path() -> str:
    runtime = os.environ.get("XDG_RUNTIME_DIR", "/tmp")
    display = os.environ.get("DISPLAY", ":1").lstrip(":").replace(".", "_")
    return os.path.join(runtime, f"coforge-dock-mru-{display}.json")


def load_mru() -> dict[str, list[int]]:
    path = mru_store_path()
    try:
        with open(path, encoding="utf-8") as handle:
            raw = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return {}
    result: dict[str, list[int]] = {}
    for key, value in raw.items():
        if isinstance(value, list):
            result[key] = [int(item) for item in value]
    return result


def save_mru(store: dict[str, list[int]]) -> None:
    path = mru_store_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(store, handle)


def prune_mru(display, root: int, store: dict[str, list[int]]) -> None:
    live = set(client_list(display, root))
    for key, values in list(store.items()):
        store[key] = [window for window in values if window in live]


def touch_mru(app_key: str, window_id: int) -> None:
    store = load_mru()
    order = [window for window in store.get(app_key, []) if window != window_id]
    store[app_key] = [window_id, *order]
    save_mru(store)


def pick_mru_window(candidates: Sequence[int], app_key: str) -> int | None:
    if not candidates:
        return None
    candidate_set = set(candidates)
    for window in load_mru().get(app_key, []):
        if window in candidate_set:
            return window
    return candidates[-1]


def window_property(display, window: int, name: str) -> list:
    actual_type = ctypes.c_ulong()
    actual_format = ctypes.c_int()
    count = ctypes.c_ulong()
    bytes_after = ctypes.c_ulong()
    data = ctypes.c_void_p()
    status = X11.XGetWindowProperty(
        display,
        window,
        X11.XInternAtom(display, name.encode(), False),
        0,
        64,
        False,
        0,
        ctypes.byref(actual_type),
        ctypes.byref(actual_format),
        ctypes.byref(count),
        ctypes.byref(bytes_after),
        ctypes.byref(data),
    )
    if status != 0 or not data or count.value == 0:
        return []
    if actual_format.value == 32:
        values = ctypes.cast(data, ctypes.POINTER(ctypes.c_ulong))
        result = [int(values[i]) for i in range(count.value)]
    elif actual_format.value == 8:
        result = [ctypes.string_at(data, count.value)]
    else:
        result = []
    X11.XFree(data)
    return result


def window_title(display, window: int) -> str:
    for prop in ("_NET_WM_NAME", "WM_NAME"):
        raw = window_property(display, window, prop)
        if not raw:
            continue
        value = raw[0]
        if isinstance(value, bytes):
            text = value.split(b"\0", 1)[0].decode(errors="replace").strip()
        else:
            text = str(value).strip()
        if text:
            return text
    return f"窗口 {window}"


def client_list(display, root: int) -> list[int]:
    return window_property(display, root, "_NET_CLIENT_LIST")


def wm_class_strings(display, window: int) -> list[str]:
    raw = window_property(display, window, "WM_CLASS")
    if not raw:
        return []
    if isinstance(raw[0], bytes):
        parts = raw[0].split(b"\0")
        return [part.decode(errors="replace") for part in parts if part]
    return [str(item) for item in raw]


def matches_wm_class(display, window: int, patterns: Sequence[str]) -> bool:
    needles = [pattern.lower() for pattern in patterns]
    for name in wm_class_strings(display, window):
        lowered = name.lower()
        if any(needle in lowered for needle in needles):
            return True
    return False


def set_workspace_count(display, root: int, count: int = 1) -> None:
    """Ask the WM to keep a single workspace (EWMH _NET_NUMBER_OF_DESKTOPS)."""
    _send_client_message(
        display,
        root,
        root,
        b"_NET_NUMBER_OF_DESKTOPS",
        int(count),
    )
    X11.XFlush(display)


def window_rect_on_root(display, root: int, window: int) -> tuple[int, int, int, int] | None:
    root_ret = ctypes.c_ulong()
    rel_x = ctypes.c_int()
    rel_y = ctypes.c_int()
    width = ctypes.c_uint()
    height = ctypes.c_uint()
    border = ctypes.c_uint()
    depth = ctypes.c_uint()
    if not X11.XGetGeometry(
        display,
        window,
        ctypes.byref(root_ret),
        ctypes.byref(rel_x),
        ctypes.byref(rel_y),
        ctypes.byref(width),
        ctypes.byref(height),
        ctypes.byref(border),
        ctypes.byref(depth),
    ):
        return None
    abs_x = ctypes.c_int()
    abs_y = ctypes.c_int()
    child = ctypes.c_ulong()
    if not X11.XTranslateCoordinates(
        display,
        window,
        root,
        0,
        0,
        ctypes.byref(abs_x),
        ctypes.byref(abs_y),
        ctypes.byref(child),
    ):
        return None
    return abs_x.value, abs_y.value, int(width.value), int(height.value)


def is_maximized(display, window: int) -> bool:
    horiz = X11.XInternAtom(display, b"_NET_WM_STATE_MAXIMIZED_HORZ", False)
    vert = X11.XInternAtom(display, b"_NET_WM_STATE_MAXIMIZED_VERT", False)
    state = window_property(display, window, "_NET_WM_STATE")
    return horiz in state and vert in state


def _ignored_shell_window(display, window: int) -> bool:
    classes = " ".join(wm_class_strings(display, window)).lower()
    for needle in ("coforge-dock-ui", "xfdesktop", "xfce4-panel"):
        if needle in classes:
            return True
    return False


def window_covers_band(
    display,
    root: int,
    band: tuple[int, int, int, int],
) -> bool:
    """True when a real app window overlaps the dock band (typically maximized)."""
    bx, by, bw, bh = band
    for window in client_list(display, root):
        if _ignored_shell_window(display, window) or is_minimized(display, window):
            continue
        rect = window_rect_on_root(display, root, window)
        if rect is None:
            continue
        x, y, w, h = rect
        if w < 32 or h < 32:
            continue
        overlaps = x < bx + bw and x + w > bx and y < by + bh and y + h > by
        if overlaps or is_maximized(display, window):
            return True
    return False


def is_minimized(display, window: int) -> bool:
    state = window_property(display, window, "WM_STATE")
    if state and int(state[0]) == IconicState:
        return True
    hidden = X11.XInternAtom(display, b"_NET_WM_STATE_HIDDEN", False)
    net_state = window_property(display, window, "_NET_WM_STATE")
    return hidden in net_state


def _send_client_message(
    display,
    root: int,
    window: int,
    message_type: bytes,
    data0: int = 0,
    data1: int = 0,
    data2: int = 0,
    data3: int = 0,
    data4: int = 0,
) -> None:
    event = XEvent()
    event.client.type = 33  # ClientMessage
    event.client.window = window
    event.client.message_type = X11.XInternAtom(display, message_type, False)
    event.client.format = 32
    event.client.data0 = data0
    event.client.data1 = data1
    event.client.data2 = data2
    event.client.data3 = data3
    event.client.data4 = data4
    # SubstructureRedirectMask | SubstructureNotifyMask
    X11.XSendEvent(display, root, False, 0x180000, ctypes.byref(event))


def activate_window(display, root: int, window: int, app_key: str | None = None) -> None:
    """Restore (if minimized), raise, and focus a window via EWMH."""
    if app_key:
        touch_mru(app_key, window)

    # Unminimize: map + clear _NET_WM_STATE_HIDDEN before activating.
    # xfwm4 often ignores a mis-addressed _NET_ACTIVE_WINDOW for iconic windows.
    X11.XMapWindow(display, window)
    hidden = X11.XInternAtom(display, b"_NET_WM_STATE_HIDDEN", False)
    _send_client_message(
        display,
        root,
        window,
        b"_NET_WM_STATE",
        NetWmStateRemove,
        int(hidden),
        0,
        1,  # source indication: application
    )
    # EWMH: ClientMessage.window = target; data0 = source (2=pager).
    _send_client_message(
        display,
        root,
        window,
        b"_NET_ACTIVE_WINDOW",
        2,  # pager / taskbar
        0,  # timestamp
        0,  # requestor's currently active window
    )
    X11.XRaiseWindow(display, window)
    X11.XFlush(display)


def minimize_window(display, window: int, app_key: str | None = None) -> None:
    if app_key:
        touch_mru(app_key, window)
    screen = X11.XDefaultScreen(display)
    X11.XIconifyWindow(display, window, screen)
    X11.XFlush(display)


def matching_windows(display, root: int, patterns: Sequence[str]) -> list[int]:
    return [
        window
        for window in client_list(display, root)
        if matches_wm_class(display, window, patterns)
    ]


def list_app_windows(display, root: int, patterns: Sequence[str]) -> list[dict]:
    rows = []
    for window in matching_windows(display, root, patterns):
        rows.append(
            {
                "id": window,
                "title": window_title(display, window),
                "minimized": is_minimized(display, window),
            }
        )
    return rows


def handle_launcher_click(display, root: int, app_key: str, patterns: Sequence[str]) -> bool:
    """Three-icon dock: minimize visible windows, else restore MRU minimized window."""
    store = load_mru()
    prune_mru(display, root, store)
    save_mru(store)

    matches = matching_windows(display, root, patterns)
    if not matches:
        return False

    visible = [window for window in matches if not is_minimized(display, window)]
    minimized = [window for window in matches if is_minimized(display, window)]

    if visible:
        for window in visible:
            minimize_window(display, window, app_key)
        return True

    if minimized:
        target = pick_mru_window(minimized, app_key)
        if target is not None:
            activate_window(display, root, target, app_key)
        return True

    return False


def focus_matching(display, root: int, patterns: Sequence[str]) -> bool:
    return handle_launcher_click(display, root, "legacy", patterns)
