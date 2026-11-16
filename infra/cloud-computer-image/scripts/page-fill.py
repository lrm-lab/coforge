#!/usr/bin/env python3
"""Type into a Chromium page on this computer without keeping a copy of the text.

The caller names a display and the fields. This process writes each value
through Chrome's debugging connection, then drops it. Nothing here is written
to a log.
"""
import json
import os

from page_fill_cdp import (
    FillError,
    cdp_base_url,
    cdp_port,
    cdp_port_from_profile,
    cdp_ports,
    cdp_token,
    chromium_profile_dir,
    display_number,
    list_pages,
    validate_fields,
)
from page_fill_dom import fill_with, inspect_with
from page_fill_ws import WebsocketCdp

__all__ = [
    "FillError",
    "WebsocketCdp",
    "cdp_base_url",
    "cdp_port",
    "cdp_port_from_profile",
    "cdp_ports",
    "cdp_token",
    "chromium_profile_dir",
    "display_number",
    "fill_display",
    "fill_with",
    "inspect_display",
    "inspect_with",
    "list_pages",
    "validate_fields",
]


def _open_pages(
    display: str,
    list_pages_fn=list_pages,
    home: str | None = None,
) -> tuple[str, list]:
    try:
        display_number(display)
    except FillError:
        raise
    base = cdp_base_url(display, home)
    if not base:
        raise FillError("browser_not_open")
    pages = list_pages_fn(base)
    if not pages:
        raise FillError("browser_not_open")
    return base, pages


def fill_display(
    display: str,
    fields,
    list_pages_fn=list_pages,
    connect=None,
    home: str | None = None,
) -> dict:
    clean = validate_fields(fields)
    _base, pages = _open_pages(display, list_pages_fn=list_pages_fn, home=home)
    opener = connect or WebsocketCdp
    last = FillError("field_not_found")
    for page in pages:
        session = opener(page["webSocketDebuggerUrl"])
        try:
            return {"filled": fill_with(session, clean)}
        except FillError as exc:
            last = exc
            if exc.code not in ("field_not_found", "not_a_password_field"):
                raise
        finally:
            close = getattr(session, "close", None)
            if close:
                close()
    raise last


def inspect_display(
    display: str,
    list_pages_fn=list_pages,
    connect=None,
    home: str | None = None,
) -> dict:
    """Return visible form fields on this display's Chromium pages."""
    _base, pages = _open_pages(display, list_pages_fn=list_pages_fn, home=home)
    opener = connect or WebsocketCdp
    for page in pages:
        session = opener(page["webSocketDebuggerUrl"])
        try:
            fields = inspect_with(session)
            if fields:
                return {"fields": fields}
        finally:
            close = getattr(session, "close", None)
            if close:
                close()
    return {"fields": []}


def main(argv: list[str] | None = None) -> int:
    """CLI: inspect the current DISPLAY's open page, printing field JSON."""
    import argparse
    import sys

    parser = argparse.ArgumentParser(description="Inspect or fill Chromium fields on this display")
    parser.add_argument(
        "--inspect",
        action="store_true",
        help="list visible text/password fields as JSON (no secrets)",
    )
    parser.add_argument(
        "--display",
        default=os.environ.get("DISPLAY", ""),
        help="X display, default $DISPLAY",
    )
    args = parser.parse_args(argv)
    if not args.inspect:
        parser.error("only --inspect is supported on the CLI; filling goes through the desktop /fill API")
    if not args.display:
        print("DISPLAY unset", file=sys.stderr)
        return 2
    try:
        result = inspect_display(args.display)
    except FillError as exc:
        print(json.dumps({"error": exc.code}), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
