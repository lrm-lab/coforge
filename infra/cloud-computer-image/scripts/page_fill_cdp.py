"""CDP discovery and field validation for page fill."""
import json
import os
import re
from urllib.request import urlopen

FIELD_ID = re.compile(r"^[a-z][a-z0-9_]{0,31}$")

MAX_VALUE = 2000


class FillError(Exception):
    def __init__(self, code: str, field: str | None = None) -> None:
        super().__init__(code)
        self.code = code
        self.field = field


def display_number(display: str) -> int:
    number = display.lstrip(":").split(".", 1)[0]
    if not number.isdigit():
        raise FillError("bad_display")
    return int(number)


def cdp_port(display: str) -> int:
    """Public proxy port for this display (9222 + number). Requires path token."""
    return 9222 + display_number(display)


def chromium_profile_dir(display: str, home: str | None = None) -> str:
    root = home if home is not None else os.environ.get("HOME", "/root")
    return os.path.join(root, ".config", "coforge-chromium", str(display_number(display)))


def cdp_token(display: str, home: str | None = None) -> str | None:
    path = os.path.join(chromium_profile_dir(display, home), "cdp.token")
    try:
        with open(path, encoding="utf-8") as handle:
            value = handle.read().strip()
    except OSError:
        return None
    if len(value) == 32 and all(ch in "0123456789abcdef" for ch in value):
        return value
    return None


def cdp_base_url(display: str, home: str | None = None) -> str | None:
    """Tokenized public CDP base, or None when this display has no token yet."""
    token = cdp_token(display, home)
    if not token:
        return None
    return f"http://127.0.0.1:{cdp_port(display)}/coforge-cdp/{token}/"


def cdp_port_from_profile(display: str, home: str | None = None) -> int | None:
    """Backend port Chromium last used for this display's profile, if any."""
    profile = chromium_profile_dir(display, home)
    for name in ("cdp.backend", "DevToolsActivePort"):
        path = os.path.join(profile, name)
        try:
            with open(path, encoding="utf-8") as handle:
                first = handle.readline().strip()
        except OSError:
            continue
        if first.isdigit():
            port = int(first)
            if 1 <= port <= 65535:
                return port
    return None


def cdp_ports(display: str, home: str | None = None) -> list[int]:
    """Legacy helper: public proxy port only (token required separately)."""
    return [cdp_port(display)]


def validate_fields(fields) -> list:
    """Selector is optional when a label is present, or the field is a password input."""
    if not isinstance(fields, list) or not fields or len(fields) > 8:
        raise FillError("bad_request")
    seen = set()
    clean = []
    for field in fields:
        if not isinstance(field, dict):
            raise FillError("bad_request")
        ident = field.get("id")
        selector = field.get("selector")
        label = field.get("label")
        value = field.get("value")
        kind = field.get("input")
        if selector is None:
            selector = ""
        if label is None:
            label = ""
        if (
            not isinstance(ident, str)
            or FIELD_ID.fullmatch(ident) is None
            or ident in seen
            or kind not in ("text", "password")
            or not isinstance(selector, str)
            or len(selector) > 300
            or not isinstance(label, str)
            or len(label) > 80
            or not isinstance(value, str)
            or len(value) > MAX_VALUE
        ):
            raise FillError("bad_request")
        selector = selector.strip()
        label = label.strip()
        if not selector and not label and kind != "password":
            raise FillError("bad_request")
        if kind == "password" and value == "":
            raise FillError("bad_request")
        seen.add(ident)
        clean.append(
            {
                "id": ident,
                "selector": selector,
                "label": label,
                "input": kind,
                "value": value,
            }
        )
    return clean


def list_pages(base_url: str) -> list:
    """List pages from a tokenized CDP base URL (…/coforge-cdp/<token>/)."""
    url = base_url if base_url.endswith("/") else base_url + "/"
    try:
        with urlopen(url + "json/list", timeout=2) as response:
            listed = json.load(response)
    except (OSError, ValueError):
        return []
    if not isinstance(listed, list):
        return []
    return [
        page
        for page in listed
        if isinstance(page, dict)
        and page.get("type") == "page"
        and isinstance(page.get("webSocketDebuggerUrl"), str)
    ]
