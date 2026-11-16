"""In-page DOM helpers for fill and inspect."""
import json

from page_fill_cdp import FIELD_ID, FillError


def _attributes(node: dict) -> dict:
    raw = node.get("attributes") or []
    return dict(zip(raw[0::2], raw[1::2]))


# Shared DOM helpers for fill and inspect. Walks iframes and shadow roots.
_PAGE_HELPERS = r"""
  function passwordInput(el) {
    return !!(el && el.nodeName === "INPUT" && String(el.type).toLowerCase() === "password");
  }
  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    const style = window.getComputedStyle ? window.getComputedStyle(el) : null;
    if (style && (style.visibility === "hidden" || style.display === "none")) return false;
    return true;
  }
  function walk(root, visit) {
    if (!root) return;
    visit(root);
    const nodes = root.querySelectorAll ? root.querySelectorAll("*") : [];
    for (const node of nodes) {
      if (node.shadowRoot) walk(node.shadowRoot, visit);
      if (node.tagName === "IFRAME") {
        try { walk(node.contentDocument, visit); } catch (e) {}
      }
    }
  }
  function search(root, selector) {
    if (!root || !selector) return null;
    try {
      if (root.querySelector) {
        const hit = root.querySelector(selector);
        if (hit) return hit;
      }
    } catch (e) {}
    const nodes = root.querySelectorAll ? root.querySelectorAll("*") : [];
    for (const node of nodes) {
      if (node.shadowRoot) {
        const inner = search(node.shadowRoot, selector);
        if (inner) return inner;
      }
      if (node.tagName === "IFRAME") {
        try {
          const inner = search(node.contentDocument, selector);
          if (inner) return inner;
        } catch (e) {}
      }
    }
    return null;
  }
  function labelText(el) {
    const bits = [];
    if (el.getAttribute) {
      for (const name of ["aria-label", "placeholder", "name", "autocomplete", "title"]) {
        const value = el.getAttribute(name);
        if (value) bits.push(value);
      }
    }
    if (el.id && el.ownerDocument) {
      try {
        const byFor = el.ownerDocument.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (byFor && byFor.textContent) bits.push(byFor.textContent);
      } catch (e) {}
    }
    try {
      const wrapped = el.closest && el.closest("label");
      if (wrapped && wrapped.textContent) bits.push(wrapped.textContent);
    } catch (e) {}
    return bits.join(" ").replace(/\s+/g, " ").trim();
  }
  function matchLabel(el, want) {
    if (!want) return false;
    const hay = labelText(el).toLowerCase();
    const needle = String(want).toLowerCase().trim();
    return !!(needle && hay && hay.indexOf(needle) !== -1);
  }
  function resolve(spec) {
    if (spec.selector) {
      const bySelector = search(document, spec.selector);
      if (bySelector) return bySelector;
    }
    let labeled = null;
    let fallback = null;
    walk(document, function(root) {
      if (labeled || !root.querySelectorAll) return;
      const inputs = root.querySelectorAll("input, textarea");
      for (const el of inputs) {
        if (!visible(el)) continue;
        const type = el.nodeName === "TEXTAREA" ? "text" : String(el.type || "text").toLowerCase();
        if (spec.password) {
          if (type !== "password") continue;
          if (spec.label && matchLabel(el, spec.label)) { labeled = el; return; }
          if (!fallback) fallback = el;
          continue;
        }
        if (type === "password" || type === "hidden" || type === "submit" || type === "button" || type === "checkbox" || type === "radio" || type === "file") continue;
        if (spec.label && matchLabel(el, spec.label)) { labeled = el; return; }
        if (!fallback) fallback = el;
      }
    });
    return labeled || fallback;
  }
"""

# Runs in the open page. Values are not returned.
_FILL_PAGE = (
    r"""(function(spec) {"""
    + _PAGE_HELPERS
    + r"""
  const el = resolve(spec);
  if (!el) return "not_found";
  if (spec.password && !passwordInput(el)) return "not_a_password_field";
  el.focus();
  const proto = el.nodeName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  if (desc && desc.set) desc.set.call(el, spec.value);
  else el.value = spec.value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return "ok";
})"""
)

_INSPECT_PAGE = (
    r"""(function() {"""
    + _PAGE_HELPERS
    + r"""
  function cssEscape(value) {
    if (window.CSS && CSS.escape) return CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }
  function suggestSelector(el) {
    if (el.id) return "#" + cssEscape(el.id);
    const name = el.getAttribute && el.getAttribute("name");
    if (name) return el.nodeName.toLowerCase() + '[name="' + name.replace(/"/g, '\\"') + '"]';
    const type = el.nodeName === "TEXTAREA" ? "text" : String(el.type || "text").toLowerCase();
    if (type === "password") return 'input[type=password]';
    if (type && type !== "text") return 'input[type="' + type + '"]';
    return el.nodeName.toLowerCase();
  }
  function suggestId(el, input, used) {
    const raw = (el.id || el.getAttribute("name") || (input === "password" ? "password" : "field") || "field")
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "");
    let base = raw.match(/^[a-z][a-z0-9_]{0,31}$/) ? raw : (input === "password" ? "password" : "field");
    let ident = base;
    let n = 2;
    while (used[ident]) {
      const suffix = String(n++);
      ident = (base.slice(0, Math.max(1, 32 - suffix.length)) + suffix);
    }
    used[ident] = true;
    return ident;
  }
  const used = {};
  const fields = [];
  walk(document, function(root) {
    if (!root.querySelectorAll) return;
    const inputs = root.querySelectorAll("input, textarea");
    for (const el of inputs) {
      if (!visible(el)) continue;
      const type = el.nodeName === "TEXTAREA" ? "text" : String(el.type || "text").toLowerCase();
      if (type === "hidden" || type === "submit" || type === "button" || type === "checkbox" || type === "radio" || type === "file" || type === "image" || type === "reset") continue;
      const input = type === "password" ? "password" : "text";
      const label = labelText(el).slice(0, 80);
      fields.push({
        id: suggestId(el, input, used),
        label: label || (input === "password" ? "Password" : "Text"),
        input: input,
        selector: suggestSelector(el).slice(0, 300),
      });
      if (fields.length >= 8) return;
    }
  });
  return fields;
})"""
)


def _evaluate_status(result) -> str | None:
    if not isinstance(result, dict) or result.get("exceptionDetails"):
        return None
    value = (result.get("result") or {}).get("value")
    if value in ("ok", "not_found", "not_a_password_field"):
        return value
    return None


def fill_with(session, fields: list) -> list:
    """Focus each field and insert its text. Password targets must be password inputs.

    A field may name a CSS selector, or omit it and resolve by label / password type.
    """
    session.call("Runtime.enable")
    filled = []
    pending = []
    for field in fields:
        spec = {
            "selector": field.get("selector") or "",
            "label": field.get("label") or "",
            "value": field["value"],
            "password": field["input"] == "password",
        }
        result = session.call(
            "Runtime.evaluate",
            {
                "expression": f"({_FILL_PAGE})({json.dumps(spec)})",
                "returnByValue": True,
            },
        )
        status = _evaluate_status(result)
        if status == "ok":
            filled.append(field["id"])
            continue
        if status == "not_a_password_field":
            raise FillError("not_a_password_field", field["id"])
        # DOM fallback only when a concrete selector was provided.
        if field.get("selector"):
            pending.append(field)
        else:
            raise FillError("field_not_found", field["id"])
    if pending:
        session.call("DOM.enable")
        document = session.call("DOM.getDocument", {"depth": -1, "pierce": True})
        root = document.get("root", {}).get("nodeId") or 0
        if not root:
            raise FillError("field_not_found", pending[0]["id"])
        targets = []
        for field in pending:
            found = session.call(
                "DOM.querySelector", {"nodeId": root, "selector": field["selector"]}
            )
            node = found.get("nodeId") or 0
            if not node:
                raise FillError("field_not_found", field["id"])
            if field["input"] == "password":
                described = session.call("DOM.describeNode", {"nodeId": node})
                info = described.get("node") or {}
                attrs = _attributes(info)
                if info.get("nodeName", "").lower() != "input" or attrs.get("type") != "password":
                    raise FillError("not_a_password_field", field["id"])
            targets.append((field, node))
        for field, node in targets:
            session.call("DOM.focus", {"nodeId": node})
            session.call(
                "Input.dispatchKeyEvent",
                {
                    "type": "keyDown",
                    "modifiers": 2,
                    "key": "a",
                    "code": "KeyA",
                    "windowsVirtualKeyCode": 65,
                },
            )
            session.call(
                "Input.dispatchKeyEvent",
                {
                    "type": "keyUp",
                    "modifiers": 2,
                    "key": "a",
                    "code": "KeyA",
                    "windowsVirtualKeyCode": 65,
                },
            )
            session.call("Input.insertText", {"text": field["value"]})
            filled.append(field["id"])
    for field in fields:
        field["value"] = ""
    return filled


def inspect_with(session) -> list:
    """List visible text/password fields on the page with suggested selectors."""
    session.call("Runtime.enable")
    result = session.call(
        "Runtime.evaluate",
        {"expression": f"({_INSPECT_PAGE})()", "returnByValue": True},
    )
    if not isinstance(result, dict) or result.get("exceptionDetails"):
        return []
    value = (result.get("result") or {}).get("value")
    if not isinstance(value, list):
        return []
    clean = []
    seen = set()
    for field in value:
        if not isinstance(field, dict):
            continue
        ident = field.get("id")
        label = field.get("label")
        kind = field.get("input")
        selector = field.get("selector")
        if (
            not isinstance(ident, str)
            or FIELD_ID.fullmatch(ident) is None
            or ident in seen
            or kind not in ("text", "password")
            or not isinstance(label, str)
            or not label.strip()
            or len(label) > 80
            or not isinstance(selector, str)
            or not selector.strip()
            or len(selector) > 300
        ):
            continue
        seen.add(ident)
        clean.append(
            {
                "id": ident,
                "label": label.strip(),
                "input": kind,
                "selector": selector.strip(),
            }
        )
        if len(clean) >= 8:
            break
    return clean
