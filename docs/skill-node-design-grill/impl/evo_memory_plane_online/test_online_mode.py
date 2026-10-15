#!/usr/bin/env python3
"""Unit tests for dense-online publish + recall mix-in (stdlib only)."""

from __future__ import annotations

import json
import os
import tempfile
import threading
import time
import unittest
from http.client import HTTPConnection
from pathlib import Path
from unittest import mock

# Fixture distilled from greenfield/smoke GMS room_shared batch shape
# (snake_case = live StageEvidenceBatchRequest; content truncated).
_GREENFIELD_STAGE = {
    "batch_id": "batch-3-29762e3dbcfd",
    "idempotency_key": "outbox-5-91f7946e5602",
    "space_id": "space-code-implementation-shared",
    "stream_id": "evidence-segment-2-54fd03356714",
    "source_segment_id": "segment-2-54fd03356714",
    "provenance": {
        "host_type": "pi-group-chat-host",
        "host_instance_id": "host-tracer",
        "source_kind": "room_shared",
        "captured_at": "2026-09-20T09:30:37.715879522Z",
        "content_sha256": "c74912ba990ff1961ea43398df62b850b01528e135241a89df09b86cf89b09bd",
    },
    "events": [
        {
            "event_id": "event-human-0001-1883-c",
            "sequence": 1,
            "kind": "room_message",
            "content": (
                "You are an expert Python programmer. You will be given a question "
                "(problem specification) and will generate a correct Python program "
                "that matches the specification and passes all tests.\n\n"
                "### Question:\nYou are given an array of integers $a_1, a_2, \\ldots, a_n$ "
                "and a number $k$ ($2 \\leq k \\leq 5$). In one operation, you can do "
                "the following:\n\n-  Choose an index $1 \\leq i \\leq n$,\n"
                "-  Set $a_i = a_i + 1$.Find the minimum number of operations needed "
                "to make the product of all the numbers in the array divisible by $k$."
            ),
            "occurred_at": "2026-09-20T09:30:37.715879522Z",
        },
        {
            "event_id": "event-message-room-code-implementation-train-1-2",
            "sequence": 2,
            "kind": "room_message",
            "content": (
                "```python\nimport sys\n\ndef solve():\n"
                "    data = sys.stdin.buffer.read().split()\n"
                "    ...\nsolve()\n```\n\nTASK_COMPLETE"
            ),
            "occurred_at": "2026-09-20T09:30:59.591824476Z",
        },
    ],
    "links": [],
    "terminal_outcome": "settled",
}

# PascalCase Events as stored in gms-warm/state.json dumps
_PASCAL_EVENTS = {
    "Events": [
        {
            "ID": "event-human-0003-2757",
            "Sequence": 1,
            "Kind": "room_message",
            "Content": (
                "Room message (untrusted content):\n"
                "You are an expert Python programmer. Count numbers with digit sum "
                "in [min_sum, max_sum].\n"
                "\nRecalled context (state=complete): ignored neighbor cards here"
            ),
        },
        {
            "ID": "event-message-room-code-implementation-7",
            "Sequence": 2,
            "Kind": "room_message",
            "Content": "```python\nclass Solution:\n    def count(self, num1, num2, min_sum, max_sum):\n        ...\n```",
        },
    ]
}


def _reset_plane_globals() -> None:
    import plane_server as ps
    import retrieval_backend_evo as rb

    with ps._backend_lock:
        ps._backend = None
    with ps._online_lock:
        ps._online = None
    rb._ONLINE = None
    rb._PAYLOAD = None


class TestTaskExtraction(unittest.TestCase):
    def test_strip_room_wrapper_and_recall_tail(self) -> None:
        from payload_resolver import strip_task_wrapper

        raw = _PASCAL_EVENTS["Events"][0]["Content"]
        got = strip_task_wrapper(raw)
        self.assertTrue(got.startswith("You are an expert Python programmer"))
        self.assertNotIn("Room message (untrusted content):", got)
        self.assertNotIn("Recalled context", got)
        self.assertIn("digit sum", got)

    def test_extract_from_greenfield_snake_case_events(self) -> None:
        from online_store import extract_episode_payload

        episode, task, solution = extract_episode_payload(_GREENFIELD_STAGE["events"])
        self.assertEqual(episode, "0001-1883-c")
        self.assertIn("expert Python programmer", task)
        self.assertIn("divisible by $k$", task)
        self.assertIn("TASK_COMPLETE", solution)
        self.assertIn("def solve", solution)

    def test_extract_from_pascal_case_gms_events(self) -> None:
        from online_store import extract_episode_payload

        episode, task, solution = extract_episode_payload(_PASCAL_EVENTS["Events"])
        self.assertEqual(episode, "0003-2757")
        self.assertEqual(
            task,
            "You are an expert Python programmer. Count numbers with digit sum "
            "in [min_sum, max_sum].",
        )
        self.assertIn("class Solution", solution)


class TestOnlineStore(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_stage_commit_and_idempotent_commit(self) -> None:
        from online_store import OnlineStore

        store = OnlineStore(self.root)
        self.assertFalse(store.stage(_GREENFIELD_STAGE))
        self.assertTrue(store.stage(_GREENFIELD_STAGE))  # duplicate stage
        dup1, entry = store.commit(_GREENFIELD_STAGE["batch_id"], "commit-1")
        self.assertFalse(dup1)
        self.assertIsNotNone(entry)
        assert entry is not None
        self.assertEqual(entry.episode_id, "0001-1883-c")
        self.assertIn("expert Python programmer", entry.task)
        dup2, entry2 = store.commit(_GREENFIELD_STAGE["batch_id"], "commit-1")
        self.assertTrue(dup2)
        self.assertEqual(entry2.episode_id, entry.episode_id)
        recent = store.recent(limit=2)
        self.assertEqual(len(recent), 1)
        self.assertEqual(recent[0].episode_id, "0001-1883-c")

    def test_recent_newest_first_cap(self) -> None:
        from online_store import OnlineStore

        store = OnlineStore(self.root)
        for i, ep in enumerate(("0001-aaaa-a", "0002-bbbb-b", "0003-cccc-c")):
            req = json.loads(json.dumps(_GREENFIELD_STAGE))
            req["batch_id"] = f"batch-{i}"
            req["events"][0]["event_id"] = f"event-human-{ep}"
            req["events"][0]["content"] = f"task body for {ep} " + "x" * 40
            req["events"][1]["content"] = f"solution {ep}"
            store.stage(req)
            store.commit(req["batch_id"], f"c-{i}")
            time.sleep(0.01)
        recent = store.recent(limit=2)
        self.assertEqual([e.episode_id for e in recent], ["0003-cccc-c", "0002-bbbb-b"])


class TestDumbRoot(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self._env = {
            "R10_PLANE_MODE": "our",
            "R10_ONLINE_ROOT": str(self.root),
            "R10_GMS_TOKEN": "test-token",
            "R10_VIEWS_ROOT": "/tmp/evo-plane/views-frozen",
        }
        self._patch = mock.patch.dict(os.environ, self._env, clear=False)
        self._patch.start()
        _reset_plane_globals()

    def tearDown(self) -> None:
        _reset_plane_globals()
        self._patch.stop()
        self._tmp.cleanup()

    def test_stage_commit_discard_in_non_online_mode(self) -> None:
        import plane_server as ps
        from http.server import ThreadingHTTPServer

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), ps.Handler)
        port = httpd.server_address[1]
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            conn = HTTPConnection("127.0.0.1", port, timeout=5)
            body = json.dumps(_GREENFIELD_STAGE).encode()
            conn.request(
                "POST",
                "/v1/evidence-batches:stage",
                body=body,
                headers={
                    "Authorization": "Bearer test-token",
                    "Content-Type": "application/json",
                    "Content-Length": str(len(body)),
                },
            )
            resp = conn.getresponse()
            data = json.loads(resp.read().decode())
            self.assertEqual(resp.status, 200)
            self.assertEqual(data["state"], "staged")
            self.assertEqual(data["duplicate"], False)
            self.assertEqual(data["batch_id"], _GREENFIELD_STAGE["batch_id"])

            cbody = json.dumps({"commit_id": "commit-x"}).encode()
            conn.request(
                "POST",
                f"/v1/evidence-batches/{_GREENFIELD_STAGE['batch_id']}:commit",
                body=cbody,
                headers={
                    "Authorization": "Bearer test-token",
                    "Content-Type": "application/json",
                    "Content-Length": str(len(cbody)),
                },
            )
            resp2 = conn.getresponse()
            data2 = json.loads(resp2.read().decode())
            self.assertEqual(resp2.status, 200)
            self.assertEqual(data2["state"], "committed")
            self.assertEqual(data2["duplicate"], False)
            self.assertFalse(any(self.root.rglob("*")), "dumb root must not write online store")
            conn.close()
        finally:
            httpd.shutdown()


class TestDenseOnlineRecall(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self._env = {
            "R10_PLANE_MODE": "dense-online",
            "R10_ONLINE_ROOT": str(self.root),
            "R10_GMS_TOKEN": "test-token",
            "R10_VIEWS_ROOT": "/tmp/evo-plane/views-frozen",
            "EVO_STAGING_ROOT": "/tmp/evo-plane/staging",
        }
        self._patch = mock.patch.dict(os.environ, self._env, clear=False)
        self._patch.start()
        _reset_plane_globals()

    def tearDown(self) -> None:
        _reset_plane_globals()
        self._patch.stop()
        self._tmp.cleanup()

    def test_fuse_reserves_online_slots(self) -> None:
        from types import SimpleNamespace

        from online_store import OnlineEntry
        from retrieval_backend_evo import fuse_dense_online

        frozen = [
            SimpleNamespace(session_id=f"train-{i}", citation_id=f"frozen-{i}")
            for i in range(5)
        ]
        online = [
            OnlineEntry(
                episode_id="test-9",
                batch_id="b9",
                task="online task nine " + "y" * 20,
                solution="sol9",
                published_at=2.0,
                event_ids=("e9",),
                space_id="space-code-implementation-shared",
            ),
            OnlineEntry(
                episode_id="test-8",
                batch_id="b8",
                task="online task eight " + "y" * 20,
                solution="sol8",
                published_at=1.0,
                event_ids=("e8",),
                space_id="space-code-implementation-shared",
            ),
        ]
        fused = fuse_dense_online(frozen, online, max_results=5, space_id="space-x")
        self.assertEqual(len(fused), 5)
        online_ids = [
            it.citation_id for it in fused
            if isinstance(it.citation_id, str) and it.citation_id.startswith("online-")
        ]
        self.assertEqual(online_ids, ["online-test-9", "online-test-8"])
        self.assertEqual(len(fused) - len(online_ids), 3)

    def test_stage_commit_recall_mixes_online(self) -> None:
        from online_store import OnlineStore
        from retrieval_backend_evo import EvoBackend

        store = OnlineStore(self.root)
        # publish two prior episodes
        for i, ep in enumerate(("0098-test-a", "0099-test-b")):
            req = json.loads(json.dumps(_GREENFIELD_STAGE))
            req["batch_id"] = f"batch-online-{i}"
            req["events"][0]["event_id"] = f"event-human-{ep}"
            req["events"][0]["content"] = (
                f"You are an expert Python programmer. Unique online marker {ep} "
                f"about modular arithmetic and prefix sums."
            )
            req["events"][1]["content"] = f"solution for {ep}\nTASK_COMPLETE"
            self.assertFalse(store.stage(req))
            dup, entry = store.commit(req["batch_id"], f"c-{i}")
            self.assertFalse(dup)
            self.assertIsNotNone(entry)
            time.sleep(0.01)

        backend = EvoBackend(Path("/tmp/evo-plane/views-frozen"), online_store=store)
        outcome = backend.recall(
            query="modular arithmetic prefix sums array",
            space_ids=["space-code-implementation-shared"],
            max_results=5,
            mode="dense-online",
        )
        self.assertEqual(outcome.filter_reason, "dense-online")
        citations = [it.citation_id for it in outcome.items]
        online_cites = [c for c in citations if c.startswith("online-")]
        self.assertTrue(online_cites, f"expected online mix-in, got {citations}")
        self.assertLessEqual(len(online_cites), 2)
        self.assertLessEqual(len(outcome.items), 5)
        # newest online episode should be preferred
        self.assertIn("online-0099-test-b", online_cites)

        # dense mode must ignore the online store
        dense = backend.recall(
            query="modular arithmetic prefix sums array",
            space_ids=["space-code-implementation-shared"],
            max_results=5,
            mode="dense",
        )
        self.assertTrue(dense.filter_reason.startswith("mode_dense") or dense.filter_reason == "no_payload")
        self.assertFalse(any(it.citation_id.startswith("online-") for it in dense.items))


if __name__ == "__main__":
    unittest.main()
