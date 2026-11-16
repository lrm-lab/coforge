#!/usr/bin/env python3
"""Chromium for this DISPLAY with a token-gated CDP proxy.

Forced CDP/profile flags come last so Agents cannot hide this display's
backend port. The public port (9222 + display) only accepts
/coforge-cdp/<token>/ — use coforge-cdp-endpoint to get the URL.
"""
from __future__ import annotations

import os
import sys

# Installed path first; fall back to sibling for local runs.
sys.path.insert(0, "/usr/local/lib/coforge")
try:
    import coforge_cdp
except ImportError:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import coforge_cdp


def main(argv: list[str]) -> int:
    info = coforge_cdp.prepare_chromium_cdp()
    chromium = "/usr/bin/chromium"
    cmd = [
        chromium,
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--start-maximized",
        *argv,
        f"--user-data-dir={info['profile']}",
        "--remote-debugging-address=127.0.0.1",
        f"--remote-debugging-port={info['backend_port']}",
    ]
    os.execv(chromium, cmd)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
