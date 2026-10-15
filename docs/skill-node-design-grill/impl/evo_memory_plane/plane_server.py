#!/usr/bin/env python3
"""R10 GMS-shaped memory plane with production causal read (OpenViking import only)."""

from __future__ import annotations

import argparse
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from retrieval_backend_evo import EvoBackend, EXPLORE_MODES

_seen: set[str] = set()
_seen_lock = threading.Lock()
_log_lock = threading.Lock()
_backend: EvoBackend | None = None
_backend_lock = threading.Lock()

# ---- exploration session budgets (coforge ADR 0052-E constants, evo bench) ----
EXPLORE_TTL_S = 10 * 60
EXPLORE_MAX_OPS = 8
EXPLORE_MAX_RESULTS = 30
_explore_sessions: dict[str, dict] = {}
_explore_lock = threading.Lock()


def _env_token() -> str:
    return os.environ.get("R10_GMS_TOKEN", "r10-blockers-local")


def _plane_mode() -> str:
    return os.environ.get("R10_PLANE_MODE", "our").strip().lower()


def _views_root() -> Path:
    default = Path(__file__).resolve().parent / "views-r9m45"
    return Path(os.environ.get("R10_VIEWS_ROOT", str(default)))


def _append_jsonl(path: str, record: dict[str, Any]) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    line = json.dumps(record, ensure_ascii=False) + "\n"
    with _log_lock:
        with open(path, "a", encoding="utf-8") as f:
            f.write(line)


def _get_backend() -> EvoBackend:
    global _backend
    with _backend_lock:
        if _backend is None:
            _backend = EvoBackend(_views_root())
        return _backend


class Handler(BaseHTTPRequestHandler):
    server_version = "r10-memory-plane/1.0"

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
        dup = _register(key)
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
            space_ids = list(req.get("space_ids") or [])
            request_id = req.get("request_id") or "recall-unknown"
            query = str(req.get("query") or "")
            max_results = int(req.get("max_results") or 5)
            deadline_ms = int(req.get("deadline_ms") or 500)
            mode = _plane_mode()
            outcome = _get_backend().recall(
                query=query,
                space_ids=space_ids,
                max_results=max_results,
                mode=mode,
            )
            items = [
                {
                    "content": it.content,
                    "source_space_id": it.source_space_id,
                    "memory_version": it.memory_version,
                    "citation": {
                        "citation_id": it.citation_id,
                        "evidence_batch_id": it.evidence_batch_id,
                        "event_ids": it.event_ids,
                    },
                    "score": it.score,
                }
                for it in outcome.items
            ]
            resp = {
                "request_id": request_id,
                "items": items,
                "degradation": {"state": outcome.degradation_state, "reasons": []},
            }
            log_path = os.environ.get("R10_RECALL_LOG", "/tmp/r10-s0/recalls.jsonl")
            _append_jsonl(
                log_path,
                {
                    "t": time.time(),
                    "plane_mode": mode,
                    "deadline_ms": deadline_ms,
                    "retrieve_elapsed_ms": outcome.elapsed_ms,
                    "deadline_exceeded": outcome.elapsed_ms > deadline_ms,
                    "channel_counts": outcome.channel_counts,
                    "family_scope": outcome.family_scope,
                    "retrieve_family": outcome.retrieve_family,
                    "placebo_donor_family": outcome.placebo_donor_family,
                    "filter_reason": outcome.filter_reason,
                    "request": req,
                    "response": resp,
                    "card_meta": [
                        {
                            "citation_id": it.citation_id,
                            "kind": it.card_kind,
                            "session_id": it.session_id,
                            "view_revision_id": it.view_revision_id,
                            "content_preview": it.content[:200],
                        }
                        for it in outcome.items
                    ],
                },
            )
            self._json_response(200, resp)
            return

        if path == "/v1/memory-explore":
            req = self._read_json()
            status, resp = _handle_explore(req)
            self._json_response(status, resp)
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


def _explore_budget_take(caller: str) -> dict:
    """One budget cell per caller (the extension keys on the episode workdir
    leaf, so budgets are per-episode as in 0052-E per-session). TTL refreshes
    on access like the coforge session TTL."""
    now = time.time()
    with _explore_lock:
        cell = _explore_sessions.get(caller)
        if cell is None or now - cell["born"] > EXPLORE_TTL_S:
            cell = {"ops": 0, "results": 0, "born": now}
            _explore_sessions[caller] = cell
        else:
            cell["born"] = now
        return cell


def _handle_explore(req: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    mode = _plane_mode()
    if mode not in EXPLORE_MODES:
        return 403, {"error": {"code": "explore_disabled", "message": f"plane mode {mode} has no exploration lane"}}
    caller = str(req.get("caller") or "unknown")
    action = str(req.get("action") or "")
    cell = _explore_budget_take(caller)
    if cell["ops"] >= EXPLORE_MAX_OPS:
        resp = {"error": {"code": "budget_exhausted",
                          "message": f"exploration budget of {EXPLORE_MAX_OPS} operations used; work with what you have"}}
    else:
        cell["ops"] += 1
        backend = _get_backend()
        if action == "search":
            results = backend.explore_search(str(req.get("query") or ""), int(req.get("n") or 5))
        elif action == "expand":
            results = [backend.explore_expand(str(req.get("session_id") or ""),
                                              str(req.get("kind") or "task"))]
        elif action == "neighbors":
            results = backend.explore_neighbors(str(req.get("session_id") or ""),
                                                int(req.get("n") or 5))
        else:
            return 400, {"error": {"code": "bad_action", "message": "action must be search|expand|neighbors"}}
        served = sum(1 for item in results if isinstance(item, dict) and "error" not in item)
        cell["results"] += served
        if cell["results"] > EXPLORE_MAX_RESULTS:
            resp = {"error": {"code": "budget_exhausted",
                              "message": f"cited-result budget of {EXPLORE_MAX_RESULTS} exceeded"}}
        else:
            resp = {"results": results,
                    "remaining_ops": EXPLORE_MAX_OPS - cell["ops"],
                    "budget": {"max_ops": EXPLORE_MAX_OPS, "max_results": EXPLORE_MAX_RESULTS}}
    log_path = os.environ.get("R10_EXPLORE_LOG", "/tmp/evo-plane/explores.jsonl")
    _append_jsonl(log_path, {
        "t": time.time(), "plane_mode": mode, "caller": caller, "action": action,
        "ops_used": cell["ops"], "results_served": cell["results"],
        "request": {k: req.get(k) for k in ("query", "session_id", "kind", "n")},
        "ok": "results" in resp,
    })
    return 200, resp


def main() -> None:
    parser = argparse.ArgumentParser(description="R10 GMS-shaped memory plane (causal read)")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8741)
    args = parser.parse_args()
    # warm import path before serving
    _get_backend()
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(
        f"r10 memory plane listening on http://{args.host}:{args.port} mode={_plane_mode()}",
        flush=True,
    )
    httpd.serve_forever()


if __name__ == "__main__":
    main()
