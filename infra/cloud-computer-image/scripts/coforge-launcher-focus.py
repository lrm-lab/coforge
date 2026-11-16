#!/usr/bin/env python3
"""Toggle dock launchers: restore minimized windows or minimize visible ones."""
import sys

sys.path.insert(0, "/usr/local/lib/coforge")

from coforge_x11 import X11, handle_launcher_click, open_display


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("usage: coforge-launcher-focus <wm-class-substring> ...", file=sys.stderr)
        return 2
    display = open_display()
    if not display:
        return 1
    root = X11.XDefaultRootWindow(display)
    if handle_launcher_click(display, root, "cli", argv[1:]):
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
