#!/usr/bin/python3
"""Minimal three-icon dock for CoForge cloud desktops.

Must use Debian /usr/bin/python3: the image also ships /usr/local/bin/python3
(from the sandbox toolchain) without PyGObject, and `env python3` picks that
first — then the dock exits immediately with ModuleNotFoundError: gi.
"""
from __future__ import annotations

import os
import subprocess
import sys
import time

sys.path.insert(0, "/usr/local/lib/coforge")

import gi

gi.require_version("Gdk", "3.0")
gi.require_version("Gtk", "3.0")
from gi.repository import Gdk, GLib, Gtk

from coforge_x11 import (
    X11,
    activate_window,
    handle_launcher_click,
    list_app_windows,
    open_display,
    set_workspace_count,
    window_covers_band,
)

DOCK_HEIGHT = 56
# A few pixels stay on-screen so the pointer can slide onto the dock.
HIDE_PEEK = 4
SHOW_EDGE_PX = 28
HOVER_DELAY_MS = 400
AUTOHIDE_POLL_MS = 200

APPS = (
    {
        "key": "browser",
        "label": "浏览器",
        "patterns": ("chromium",),
        "icon_name": "chromium",
        "launch": ("/usr/local/bin/coforge-chromium",),
        "launch_new": ("/usr/local/bin/coforge-chromium", "--new-window"),
    },
    {
        "key": "files",
        "label": "文件",
        "patterns": ("thunar",),
        "icon_name": "org.xfce.thunar",
        "launch": ("/usr/local/bin/coforge-thunar",),
        "launch_new": ("/usr/local/bin/coforge-thunar",),
    },
    {
        "key": "terminal",
        "label": "终端",
        "patterns": ("xfce4-terminal",),
        "icon_name": "utilities-terminal",
        "launch": ("/usr/local/bin/coforge-terminal",),
        "launch_new": ("/usr/local/bin/coforge-terminal",),
    },
)


class WindowPreview(Gtk.Window):
    def __init__(self, dock: "CoforgeDock", app: dict) -> None:
        super().__init__(type=Gtk.WindowType.POPUP)
        self.dock = dock
        self.app = app
        self.set_decorated(False)
        self.set_resizable(False)
        self.get_style_context().add_class("coforge-dock-preview")
        self.box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        self.box.set_margin_top(8)
        self.box.set_margin_bottom(8)
        self.box.set_margin_start(10)
        self.box.set_margin_end(10)
        self.add(self.box)
        self.connect("leave-notify-event", self._on_leave)

    def _on_leave(self, _widget, _event) -> None:
        GLib.timeout_add(250, self._maybe_hide)

    def _maybe_hide(self) -> bool:
        if not self.get_visible():
            return False
        self.hide()
        self.dock.preview_visible = False
        return False

    def populate(self, anchor: Gtk.Widget) -> None:
        for child in list(self.box.get_children()):
            self.box.remove(child)
            child.destroy()

        display = self.dock.xdisplay
        if not display:
            return
        root = X11.XDefaultRootWindow(display)
        windows = list_app_windows(display, root, self.app["patterns"])
        if len(windows) < 2:
            self.hide()
            self.dock.preview_visible = False
            return

        for row in windows:
            prefix = "▾ " if row["minimized"] else "▴ "
            title = prefix + row["title"]
            button = Gtk.Button(label=title)
            button.get_style_context().add_class("coforge-dock-preview-item")
            button.set_relief(Gtk.ReliefStyle.NONE)
            button.set_halign(Gtk.Align.FILL)
            button.connect(
                "clicked",
                self._on_pick,
                row["id"],
            )
            self.box.pack_start(button, False, False, 0)

        self.show_all()
        alloc = anchor.get_allocation()
        anchor_x, anchor_y = anchor.translate_coordinates(self.dock.window, 0, 0)
        dock_x, dock_y = self.dock.window.get_position()
        _, pref_height = self.get_preferred_height()
        screen = Gdk.Screen.get_default()
        geometry = screen.get_monitor_geometry(screen.get_primary_monitor())
        popup_x = dock_x + anchor_x + alloc.width // 2 - 160
        popup_x = max(geometry.x + 8, min(popup_x, geometry.x + geometry.width - 328))
        popup_y = dock_y + anchor_y - pref_height + 10
        self.move(popup_x, max(geometry.y + 8, popup_y))
        self.resize(320, pref_height)
        self.dock.preview_visible = True

    def _on_pick(self, _button, window_id: int) -> None:
        display = self.dock.xdisplay
        if not display:
            return
        root = X11.XDefaultRootWindow(display)
        activate_window(display, root, window_id, self.app["key"])
        self.hide()


class CoforgeDock:
    def __init__(self) -> None:
        self.xdisplay = None
        self.root = None
        self.preview: WindowPreview | None = None
        self.hover_token = 0
        self.pointer_inside = False
        self.preview_visible = False

        # xfwm4 clamps a managed window and only lets it slide halfway off the
        # screen. Bypass that after realize, before the window is mapped.
        self.window = Gtk.Window(type=Gtk.WindowType.TOPLEVEL)
        self.window.set_decorated(False)
        self.window.set_resizable(False)
        self.window.set_keep_above(True)
        self.window.set_accept_focus(False)
        self.window.set_skip_taskbar_hint(True)
        self.window.set_skip_pager_hint(True)
        # Survive accidental workspace switches (e.g. wheel on desktop).
        self.window.stick()
        self.window.set_app_paintable(True)
        self.window.get_style_context().add_class("coforge-dock")
        screen = self.window.get_screen()
        visual = screen.get_rgba_visual()
        if visual and screen.is_composited():
            self.window.set_visual(visual)

        self.box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12)
        self.box.set_halign(Gtk.Align.CENTER)
        self.box.set_valign(Gtk.Align.CENTER)
        self.window.add(self.box)

        for app in APPS:
            button = Gtk.Button()
            button.set_relief(Gtk.ReliefStyle.NONE)
            button.get_style_context().add_class("coforge-dock-button")
            icon = Gtk.Image.new_from_icon_name(app["icon_name"], Gtk.IconSize.DIALOG)
            button.set_image(icon)
            button.set_tooltip_text(
                f"{app['label']}\n单击：切换窗口\nShift+单击：新建\n右键：窗口列表"
            )
            button.connect("button-press-event", self._on_button_press, app)
            button.connect("enter-notify-event", self._on_enter, app, button)
            button.connect("leave-notify-event", self._on_leave)
            self.box.pack_start(button, False, False, 0)

        self.window.realize()
        gdk_window = self.window.get_window()
        if gdk_window is not None:
            gdk_window.set_override_redirect(True)
        self.window.connect("enter-notify-event", lambda *_: self._set_pointer_inside(True))
        self.window.connect("leave-notify-event", lambda *_: self._set_pointer_inside(False))
        self.window.show_all()
        self._snap()
        GLib.timeout_add(AUTOHIDE_POLL_MS, self._autohide_tick)
        GLib.timeout_add(500, self._refresh_running_dots)

    def _set_pointer_inside(self, inside: bool) -> None:
        self.pointer_inside = inside

    def _screen_box(self):
        screen = Gdk.Screen.get_default()
        monitor = screen.get_primary_monitor()
        geometry = screen.get_monitor_geometry(monitor)
        width = min(280, geometry.width)
        x = geometry.x + (geometry.width - width) // 2
        return geometry, x, width

    def _should_hide(self) -> bool:
        if self.pointer_inside or self.preview_visible:
            return False
        gdk_display = Gdk.Display.get_default()
        _, _pointer_x, pointer_y, _ = gdk_display.get_pointer()
        geometry, _, _ = self._screen_box()
        if pointer_y >= geometry.y + geometry.height - SHOW_EDGE_PX:
            return False
        display = self.xdisplay
        if not display:
            return False
        root = X11.XDefaultRootWindow(display)
        band = (
            geometry.x,
            geometry.y + geometry.height - DOCK_HEIGHT,
            geometry.width,
            DOCK_HEIGHT,
        )
        return window_covers_band(display, root, band)

    def _snap(self) -> None:
        """Show the full dock, or collapse it to a thin on-screen strip.

        Shrinking (instead of pushing the window past the edge) is required:
        xfwm4 refuses to move a normal window mostly off-screen and leaves the
        icons half visible.
        """
        geometry, x, width = self._screen_box()
        hide = self._should_hide()
        if hide:
            if self.box.get_visible():
                self.box.hide()
            height = HIDE_PEEK
        else:
            if not self.box.get_visible():
                self.box.show_all()
            height = DOCK_HEIGHT
        self.window.set_size_request(width, height)
        self.window.resize(width, height)
        self.window.move(x, geometry.y + geometry.height - height)
        gdk_window = self.window.get_window()
        if gdk_window is not None:
            gdk_window.raise_()

    def _autohide_tick(self) -> bool:
        self._snap()
        return True

    def _refresh_running_dots(self) -> bool:
        display = self.xdisplay
        if display:
            root = X11.XDefaultRootWindow(display)
            for index, app in enumerate(APPS):
                button = self.box.get_children()[index]
                windows = list_app_windows(display, root, app["patterns"])
                context = button.get_style_context()
                if windows:
                    context.add_class("coforge-dock-running")
                else:
                    context.remove_class("coforge-dock-running")
        return True

    def _launch(self, argv: tuple[str, ...]) -> None:
        env = os.environ.copy()
        subprocess.Popen(argv, env=env, start_new_session=True)

    def _on_button_press(self, widget, event, app: dict) -> bool:
        if event.button == 3:
            self._open_context_menu(app, widget, event)
            return True
        if event.button != 1:
            return False

        if event.state & Gdk.ModifierType.SHIFT_MASK:
            self._launch(app["launch_new"])
            return True

        display = self.xdisplay
        if not display:
            self._launch(app["launch"])
            return True
        root = X11.XDefaultRootWindow(display)
        if not handle_launcher_click(display, root, app["key"], app["patterns"]):
            self._launch(app["launch"])
        return True

    def _open_context_menu(self, app: dict, widget: Gtk.Widget, event) -> None:
        menu = Gtk.Menu()
        item_new = Gtk.MenuItem(label="新建窗口")
        item_new.connect("activate", lambda *_: self._launch(app["launch_new"]))
        menu.append(item_new)

        display = self.xdisplay
        if display:
            root = X11.XDefaultRootWindow(display)
            windows = list_app_windows(display, root, app["patterns"])
            if windows:
                menu.append(Gtk.SeparatorMenuItem())
                for row in windows:
                    label = row["title"]
                    if row["minimized"]:
                        label = f"（最小化）{label}"
                    item = Gtk.MenuItem(label=label)
                    item.connect(
                        "activate",
                        lambda _item, window_id=row["id"]: self._activate(app, window_id),
                    )
                    menu.append(item)

        menu.show_all()
        menu.popup_at_pointer(event)

    def _activate(self, app: dict, window_id: int) -> None:
        display = self.xdisplay
        if not display:
            return
        root = X11.XDefaultRootWindow(display)
        activate_window(display, root, window_id, app["key"])

    def _on_enter(self, _widget, _event, app: dict, button: Gtk.Button) -> None:
        self.hover_token += 1
        token = self.hover_token

        def show_preview() -> bool:
            if token != self.hover_token:
                return False
            display = self.xdisplay
            if not display:
                return False
            root = X11.XDefaultRootWindow(display)
            if len(list_app_windows(display, root, app["patterns"])) < 2:
                return False
            if self.preview is None:
                self.preview = WindowPreview(self, app)
            self.preview_visible = True
            self.preview.populate(button)
            return False

        GLib.timeout_add(HOVER_DELAY_MS, show_preview)

    def _on_leave(self, _widget, _event) -> None:
        self.hover_token += 1
        GLib.timeout_add(450, self._hide_preview)

    def _hide_preview(self) -> bool:
        if self.preview and self.preview.get_visible():
            display = Gdk.Display.get_default()
            screen, x, y, _ = display.get_pointer()
            preview = self.preview.get_window()
            if preview:
                _, px, py = preview.get_origin()
                pw = preview.get_width()
                ph = preview.get_height()
                if px <= x <= px + pw and py <= y <= py + ph:
                    return False
            self.preview.hide()
        self.preview_visible = False
        return False


def wait_for_x() -> bool:
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        display = open_display()
        if display:
            return True
        time.sleep(0.2)
    return False


def main() -> int:
    if not wait_for_x():
        return 1
    Gtk.init(sys.argv)
    dock = CoforgeDock()
    dock.xdisplay = open_display()
    if dock.xdisplay:
        dock.root = X11.XDefaultRootWindow(dock.xdisplay)
        set_workspace_count(dock.xdisplay, dock.root, 1)
    Gtk.main()
    return 0


if __name__ == "__main__":
    sys.exit(main())
