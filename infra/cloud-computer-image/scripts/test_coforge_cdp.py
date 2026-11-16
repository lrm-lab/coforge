#!/usr/bin/env python3
"""Token-gated CDP proxy rejects bare localhost connects."""
import json
import os
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from importlib.machinery import SourceFileLoader
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import urlopen

HERE = os.path.dirname(os.path.abspath(__file__))
cdp = SourceFileLoader("coforge_cdp", os.path.join(HERE, "coforge_cdp.py")).load_module()

TOKEN = "b" * 32


class BackendHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):  # noqa: A003
        return

    def do_GET(self):  # noqa: N802
        if self.path.startswith("/json/version"):
            body = json.dumps(
                {
                    "Browser": "test",
                    "webSocketDebuggerUrl": "ws://127.0.0.1:%d/devtools/browser/x"
                    % self.server.server_address[1],
                }
            ).encode()
        elif self.path.startswith("/json/list"):
            body = json.dumps(
                [
                    {
                        "type": "page",
                        "webSocketDebuggerUrl": "ws://127.0.0.1:%d/devtools/page/1"
                        % self.server.server_address[1],
                    }
                ]
            ).encode()
        else:
            self.send_response(404)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class CdpProxyTest(unittest.TestCase):
    def setUp(self):
        self.backend = HTTPServer(("127.0.0.1", 0), BackendHandler)
        self.backend_port = self.backend.server_address[1]
        threading.Thread(target=self.backend.serve_forever, daemon=True).start()
        self.public = cdp.allocate_loopback_port()
        self.proxy = cdp.serve_proxy(self.public, self.backend_port, TOKEN)

    def tearDown(self):
        self.proxy.shutdown()
        self.backend.shutdown()

    def test_bare_public_port_is_forbidden(self):
        with self.assertRaises(HTTPError) as caught:
            urlopen(f"http://127.0.0.1:{self.public}/json/list", timeout=2)
        self.assertEqual(caught.exception.code, 403)

    def test_token_path_rewrites_websocket_urls(self):
        with urlopen(
            f"http://127.0.0.1:{self.public}/coforge-cdp/{TOKEN}/json/list", timeout=2
        ) as response:
            pages = json.load(response)
        url = pages[0]["webSocketDebuggerUrl"]
        self.assertIn(f"/coforge-cdp/{TOKEN}/devtools/page/1", url)
        self.assertIn(f":{self.public}/", url)
        self.assertNotIn(f":{self.backend_port}/", url)

    def test_endpoint_requires_display(self):
        env = os.environ.pop("DISPLAY", None)
        try:
            with self.assertRaises(SystemExit):
                cdp.resolve_endpoint()
        finally:
            if env is not None:
                os.environ["DISPLAY"] = env

    def test_prepare_writes_token(self):
        with tempfile.TemporaryDirectory() as home:
            os.environ["HOME"] = home
            os.environ["DISPLAY"] = ":31"
            # Use an isolated public port by mocking display 31 → 9253; free it.
            info = cdp.prepare_chromium_cdp(":31", home=home)
            self.assertTrue(Path(info["profile"], "cdp.token").is_file())
            self.assertEqual(len(info["token"]), 32)
            self.assertIn(info["token"], info["endpoint"])
            # cleanup proxy
            try:
                pid = int(Path(info["profile"], "cdp-proxy.pid").read_text().strip())
                os.kill(pid, 15)
            except (OSError, ValueError):
                pass


if __name__ == "__main__":
    unittest.main()
