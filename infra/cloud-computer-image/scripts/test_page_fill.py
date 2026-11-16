#!/usr/bin/env python3
"""Page fill never echoes a value, and it refuses a password box that is not one."""
import os
import unittest
from importlib.machinery import SourceFileLoader
from pathlib import Path
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
page_fill = SourceFileLoader("page_fill", os.path.join(HERE, "page-fill.py")).load_module()


class FakeSession:
    def __init__(self, password_type="password"):
        self.calls = []
        self.password_type = password_type

    def call(self, method, params=None):
        self.calls.append((method, params))
        if method == "Runtime.evaluate":
            return {}
        if method == "DOM.getDocument":
            return {"root": {"nodeId": 1}}
        if method == "DOM.querySelector":
            return {"nodeId": 9 if "pass" in params["selector"] else 4}
        if method == "DOM.describeNode":
            return {
                "node": {
                    "nodeName": "INPUT",
                    "attributes": ["type", self.password_type],
                }
            }
        return {}

    def close(self):
        return None


SECRET = "s3cret-value"
TOKEN = "a" * 32


class PageFillTest(unittest.TestCase):
    def test_display_port_matches_chromium(self):
        self.assertEqual(page_fill.cdp_port(":1"), 9223)
        self.assertEqual(page_fill.cdp_port(":20"), 9242)

    def test_cdp_base_url_requires_token_file(self):
        with tempfile.TemporaryDirectory() as home:
            self.assertIsNone(page_fill.cdp_base_url(":29", home=home))
            profile = Path(home) / ".config" / "coforge-chromium" / "29"
            profile.mkdir(parents=True)
            (profile / "cdp.token").write_text(TOKEN + "\n", encoding="utf-8")
            self.assertEqual(
                page_fill.cdp_base_url(":29", home=home),
                f"http://127.0.0.1:9251/coforge-cdp/{TOKEN}/",
            )

    def test_fill_uses_tokenized_base_url(self):
        seen = []

        def list_pages(base):
            seen.append(base)
            return [
                {
                    "type": "page",
                    "webSocketDebuggerUrl": f"ws://127.0.0.1:9251/coforge-cdp/{TOKEN}/devtools/page/1",
                }
            ]

        class Session:
            def call(self, method, params=None):
                if method == "Runtime.enable":
                    return {}
                if method == "Runtime.evaluate":
                    return {"result": {"value": "ok"}}
                return {}

            def close(self):
                return None

        with tempfile.TemporaryDirectory() as home:
            profile = Path(home) / ".config" / "coforge-chromium" / "29"
            profile.mkdir(parents=True)
            (profile / "cdp.token").write_text(TOKEN + "\n", encoding="utf-8")
            fields = [{"id": "phone", "selector": "input", "input": "text", "value": "186"}]
            filled = page_fill.fill_display(
                ":29",
                fields,
                list_pages_fn=list_pages,
                connect=lambda _url: Session(),
                home=home,
            )
            self.assertEqual(filled, {"filled": ["phone"]})
            self.assertEqual(seen, [f"http://127.0.0.1:9251/coforge-cdp/{TOKEN}/"])

    def test_inserts_text_and_forgets_it(self):
        session = FakeSession()
        fields = [
            {"id": "username", "selector": "#user", "input": "text", "value": "ada"},
            {"id": "password", "selector": "#pass", "input": "password", "value": SECRET},
        ]
        filled = page_fill.fill_with(session, fields)
        self.assertEqual(filled, ["username", "password"])
        inserted = [
            params["text"]
            for method, params in session.calls
            if method == "Input.insertText"
        ]
        self.assertEqual(inserted, ["ada", SECRET])
        self.assertTrue(all(field["value"] == "" for field in fields))

    def test_a_password_target_that_is_plain_text_is_refused(self):
        session = FakeSession(password_type="text")
        fields = [
            {"id": "password", "selector": "#pass", "input": "password", "value": SECRET},
        ]
        with self.assertRaises(page_fill.FillError) as caught:
            page_fill.fill_with(session, fields)
        self.assertEqual(caught.exception.code, "not_a_password_field")
        self.assertNotIn(SECRET, str(caught.exception))
        self.assertTrue(
            all(
                method != "Input.insertText" or SECRET not in (params or {}).get("text", "")
                for method, params in session.calls
            )
        )

    def test_page_script_can_fill_without_dom_fallback(self):
        session = FakeSession()

        def call(method, params=None):
            session.calls.append((method, params))
            if method == "Runtime.enable":
                return {}
            if method == "Runtime.evaluate":
                return {"result": {"value": "ok"}}
            raise AssertionError(method)

        session.call = call
        fields = [{"id": "username", "selector": "#user", "input": "text", "value": "ada"}]
        self.assertEqual(page_fill.fill_with(session, fields), ["username"])
        self.assertEqual(fields[0]["value"], "")
        self.assertTrue(any(method == "Runtime.evaluate" for method, _ in session.calls))

    def test_missing_browser_does_not_include_the_value(self):
        with self.assertRaises(page_fill.FillError) as caught:
            page_fill.fill_display(
                ":20",
                [{"id": "password", "selector": "#pass", "input": "password", "value": SECRET}],
                list_pages_fn=lambda _base: [],
            )
        self.assertEqual(caught.exception.code, "browser_not_open")
        self.assertNotIn(SECRET, str(caught.exception))

    def test_label_only_password_field_is_accepted(self):
        clean = page_fill.validate_fields(
            [{"id": "password", "label": "Password", "input": "password", "value": SECRET}]
        )
        self.assertEqual(clean[0]["selector"], "")
        self.assertEqual(clean[0]["label"], "Password")

    def test_text_field_without_selector_or_label_is_rejected(self):
        with self.assertRaises(page_fill.FillError) as caught:
            page_fill.validate_fields(
                [{"id": "username", "input": "text", "value": "ada"}]
            )
        self.assertEqual(caught.exception.code, "bad_request")

    def test_fill_resolves_by_label_without_selector(self):
        session = FakeSession()

        def call(method, params=None):
            session.calls.append((method, params))
            if method == "Runtime.enable":
                return {}
            if method == "Runtime.evaluate":
                expression = (params or {}).get("expression", "")
                self.assertIn('"label": "Password"', expression)
                self.assertIn('"selector": ""', expression)
                return {"result": {"value": "ok"}}
            raise AssertionError(method)

        session.call = call
        fields = [
            {
                "id": "password",
                "label": "Password",
                "selector": "",
                "input": "password",
                "value": SECRET,
            }
        ]
        self.assertEqual(page_fill.fill_with(session, fields), ["password"])
        self.assertEqual(fields[0]["value"], "")

    def test_inspect_returns_field_names_only(self):
        session = FakeSession()

        def call(method, params=None):
            if method == "Runtime.enable":
                return {}
            if method == "Runtime.evaluate":
                return {
                    "result": {
                        "value": [
                            {
                                "id": "password",
                                "label": "Password",
                                "input": "password",
                                "selector": "input[type=password]",
                            }
                        ]
                    }
                }
            raise AssertionError(method)

        session.call = call
        self.assertEqual(
            page_fill.inspect_with(session),
            [
                {
                    "id": "password",
                    "label": "Password",
                    "input": "password",
                    "selector": "input[type=password]",
                }
            ],
        )


if __name__ == "__main__":
    unittest.main()
