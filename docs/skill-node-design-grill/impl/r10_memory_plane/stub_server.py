#!/usr/bin/env python3
"""R10 minimal GMS-shaped memory plane stub (stdlib only)."""

from __future__ import annotations

import argparse
import json
import os
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlparse

ISOLATED_SHARED_RE = re.compile(r"-(test|train)-\d+-shared$")

FIXED_CONTENT = (
    "R10 stub memory card: placeholder causal-read text for pipeline smoke. "
    "Not task-specific; only proves recall injection into the Pi prompt."
)

_seen: set[str] = set()
_seen_lock = threading.Lock()
_log_lock = threading.Lock()


def _env_token() -> str:
    return os.environ.get("R10_GMS_TOKEN", "r10-blockers-local")


def _serve_recall() -> bool:
    return os.environ.get("R10_SERVE_RECALL", "0") == "1"


def _append_jsonl(path: str, record: dict[str, Any]) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    line = json.dumps(record, ensure_ascii=False) + "\n"
    with _log_lock:
        with open(path, "a", encoding="utf-8") as f:
            f.write(line)


def _family_shared_scope(space_ids: list[str]) -> str | None:
    for sid in space_ids:
        if sid.endswith("-shared") and not ISOLATED_SHARED_RE.search(sid):
            return sid
    return None


class Handler(BaseHTTPRequestHandler):
    server_version = "r10-memory-plane-stub/0.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        return

    def _auth_ok(self) -> bool:
        auth = self.headers.get("Authorization", "")
        expected = "Bearer " + _env_token()
        return auth == expected

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        return json.loads(raw.decode("utf-8") or "{}")

    def _json_response(self, status: int, body: dict[str, Any]) -> None:
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _unauthorized(self) -> None:
        self._json_response(
            401,
            {"error": {"code": "unauthorized", "message": "invalid bearer token"}},
        )

    def do_PUT(self) -> None:
        if not self._auth_ok():
            return self._unauthorized()
        if self.path != "/v1/tenant":
            return self._json_response(404, {"error": {"code": "not_found", "message": "unknown path"}})
        req = self._read_json()
        key = f"tenant:{req.get('tenant_id')}"
        dup = False
        with _seen_lock:
            if key in _seen:
                dup = True
            else:
                _seen.add(key)
        self._json_response(
            200,
            {
                "tenant_id": req.get("tenant_id"),
                "bootstrap_principal_id": req.get("bootstrap_principal_id"),
                "duplicate": dup,
            },
        )

    def do_POST(self) -> None:
        if not self._auth_ok():
            return self._unauthorized()
        path = urlparse(self.path).path

        if path == "/v1/principals":
            req = self._read_json()
            key = f"principal:{req.get('principal_id')}"
            dup = _register(key)
            self._json_response(
                200,
                {
                    "principal_id": req.get("principal_id"),
                    "kind": req.get("kind"),
                    "duplicate": dup,
                },
            )
            return

        if path == "/v1/spaces":
            req = self._read_json()
            key = f"space:{req.get('space_id')}"
            dup = _register(key)
            self._json_response(
                200,
                {
                    "space_id": req.get("space_id"),
                    "scope": req.get("scope"),
                    "owner_principal_id": req.get("owner_principal_id"),
                    "duplicate": dup,
                },
            )
            return

        if path == "/v1/grants":
            req = self._read_json()
            key = f"grant:{req.get('grant_id')}"
            dup = _register(key)
            self._json_response(
                200,
                {
                    "grant_id": req.get("grant_id"),
                    "principal_id": req.get("principal_id"),
                    "space_ids": req.get("space_ids", []),
                    "purpose": req.get("purpose"),
                    "operations": req.get("operations", []),
                    "expires_at": req.get("expires_at"),
                    "duplicate": dup,
                },
            )
            return

        if path == "/v1/recalls":
            req = self._read_json()
            space_ids = req.get("space_ids") or []
            request_id = req.get("request_id") or "recall-unknown"
            items: list[dict[str, Any]] = []
            state = "complete"
            family_space = _family_shared_scope(space_ids) if _serve_recall() else None
            if family_space:
                items.append(
                    {
                        "content": FIXED_CONTENT,
                        "source_space_id": family_space,
                        "memory_version": 1,
                        "citation": {
                            "citation_id": "cit-r10-stub-001",
                            "evidence_batch_id": "batch-r10-stub",
                            "event_ids": ["evt-r10-stub-1"],
                        },
                        "score": 0.99,
                    }
                )
            else:
                state = "empty" if not items else "complete"

            resp = {
                "request_id": request_id,
                "items": items,
                "degradation": {"state": state, "reasons": []},
            }
            log_path = os.environ.get(
                "R10_RECALL_LOG",
                "/tmp/r10/recalls.jsonl",
            )
            _append_jsonl(
                log_path,
                {
                    "t": time.time(),
                    "serve_recall": _serve_recall(),
                    "request": req,
                    "response": resp,
                },
            )
            self._json_response(200, resp)
            return

        if path == "/v1/evidence-batches:stage":
            req = self._read_json()
            self._json_response(
                200,
                {
                    "batch_id": req.get("batch_id"),
                    "idempotency_key": req.get("idempotency_key"),
                    "space_id": req.get("space_id"),
                    "state": "staged",
                    "duplicate": False,
                },
            )
            return

        if path.endswith(":commit") and path.startswith("/v1/evidence-batches/"):
            batch_id = path.removeprefix("/v1/evidence-batches/").removesuffix(":commit")
            self._json_response(
                200,
                {
                    "batch_id": batch_id,
                    "commit_id": self._read_json().get("commit_id"),
                    "state": "committed",
                    "memory_version": 1,
                    "committed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "duplicate": False,
                },
            )
            return

        self._json_response(404, {"error": {"code": "not_found", "message": "unknown path"}})


def _register(key: str) -> bool:
    with _seen_lock:
        if key in _seen:
            return True
        _seen.add(key)
        return False


def main() -> None:
    parser = argparse.ArgumentParser(description="R10 GMS-shaped memory plane stub")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8741)
    args = parser.parse_args()
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"r10 memory plane stub listening on http://{args.host}:{args.port}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
