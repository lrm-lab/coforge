"""Online episode store for dense-online arm-internal accumulation.

Frozen views cannot see test→test publishes from the same run. This module
persists GMS stage/commit batches under ``R10_ONLINE_ROOT`` and indexes the
episode task text (and final solution) so recall/explore can mix recent
same-run neighbors into dense payloads.

Invariant: only ``dense-online`` mode may stage/commit into this store; other
plane modes keep the historical dumb-root semantics (accept + discard).
"""

from __future__ import annotations

import json
import os
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from payload_resolver import SOLUTION_CAP, TASK_CAP, strip_task_wrapper

_HUMAN_PREFIX = "event-human-"
DEFAULT_ONLINE_ROOT = "/tmp/evo-plane/online-store"


def online_root() -> Path:
    return Path(os.environ.get("R10_ONLINE_ROOT", DEFAULT_ONLINE_ROOT))


def _field(obj: dict[str, Any], *names: str, default: Any = None) -> Any:
    for name in names:
        if name in obj and obj[name] is not None:
            return obj[name]
    return default


def _event_id(event: dict[str, Any]) -> str:
    return str(_field(event, "event_id", "ID", "Id", default="") or "")


def _event_kind(event: dict[str, Any]) -> str:
    return str(_field(event, "kind", "Kind", default="") or "")


def _event_content(event: dict[str, Any]) -> str:
    return str(_field(event, "content", "Content", default="") or "")


def _event_sequence(event: dict[str, Any]) -> int:
    raw = _field(event, "sequence", "Sequence", default=0)
    try:
        return int(raw or 0)
    except (TypeError, ValueError):
        return 0


def episode_id_from_events(events: list[dict[str, Any]]) -> str:
    """Derive episode leaf id from the first human event id when present."""
    for event in events:
        eid = _event_id(event)
        if eid.startswith(_HUMAN_PREFIX):
            return eid[len(_HUMAN_PREFIX) :]
    if events:
        eid = _event_id(events[0])
        if eid:
            return eid
    return ""


def extract_episode_payload(events: list[dict[str, Any]]) -> tuple[str, str, str]:
    """Return ``(episode_id, task_text, solution_text)`` from room_message events.

    Task = first human room message (wrapper stripped). Solution = last
    non-human room_message content. Empty strings when not recoverable.
    """
    room = [e for e in events if _event_kind(e) == "room_message" or not _event_kind(e)]
    if not room:
        room = list(events)
    room = sorted(room, key=_event_sequence) if any(_event_sequence(e) for e in room) else room

    human = [e for e in room if _event_id(e).startswith(_HUMAN_PREFIX)]
    if not human and room:
        human = [room[0]]
    agents = [e for e in room if not _event_id(e).startswith(_HUMAN_PREFIX)]
    if not agents and len(room) > 1:
        agents = [room[-1]]

    episode = episode_id_from_events(human or room)
    task = strip_task_wrapper(_event_content(human[0])) if human else ""
    solution = _event_content(agents[-1]).strip() if agents else ""
    return episode, task, solution


@dataclass(frozen=True)
class OnlineEntry:
    episode_id: str
    batch_id: str
    task: str
    solution: str
    published_at: float
    event_ids: tuple[str, ...]
    space_id: str


class OnlineStore:
    """Append-only jsonl store with an in-memory index keyed by batch/episode."""

    def __init__(self, root: Path | None = None) -> None:
        self.root = Path(root) if root is not None else online_root()
        self.root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._staged: dict[str, dict[str, Any]] = {}
        self._by_batch: dict[str, OnlineEntry] = {}
        self._entries: list[OnlineEntry] = []
        self._load()

    def _staged_path(self, batch_id: str) -> Path:
        return self.root / "staged" / f"{batch_id}.json"

    def _committed_path(self) -> Path:
        return self.root / "committed.jsonl"

    def _load(self) -> None:
        staged_dir = self.root / "staged"
        if staged_dir.is_dir():
            for path in staged_dir.glob("*.json"):
                try:
                    self._staged[path.stem] = json.loads(path.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    continue
        self._reload_committed_unlocked()

    @staticmethod
    def _entry_from_record(rec: dict[str, Any]) -> OnlineEntry | None:
        episode = str(rec.get("episode_id") or "")
        batch_id = str(rec.get("batch_id") or "")
        task = str(rec.get("task") or "")
        if not episode or not batch_id or not task:
            return None
        return OnlineEntry(
            episode_id=episode,
            batch_id=batch_id,
            task=task[:TASK_CAP],
            solution=str(rec.get("solution") or "")[:SOLUTION_CAP],
            published_at=float(rec.get("published_at") or 0.0),
            event_ids=tuple(str(x) for x in (rec.get("event_ids") or [])),
            space_id=str(rec.get("space_id") or ""),
        )

    def stage(self, req: dict[str, Any]) -> bool:
        """Persist a staged batch. Returns True when this call is a duplicate stage."""
        batch_id = str(req.get("batch_id") or "")
        if not batch_id:
            return False
        with self._lock:
            self._reload_committed_unlocked()
            if batch_id in self._staged or batch_id in self._by_batch:
                return True
            path = self._staged_path(batch_id)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(req, ensure_ascii=False), encoding="utf-8")
            self._staged[batch_id] = req
            return False

    def commit(self, batch_id: str, commit_id: str | None = None) -> tuple[bool, OnlineEntry | None]:
        """Commit a previously staged batch. Returns (duplicate, entry)."""
        with self._lock:
            self._reload_committed_unlocked()
            if batch_id in self._by_batch:
                return True, self._by_batch[batch_id]
            req = self._staged.get(batch_id)
            if req is None:
                path = self._staged_path(batch_id)
                if path.is_file():
                    try:
                        req = json.loads(path.read_text(encoding="utf-8"))
                    except (OSError, json.JSONDecodeError):
                        req = None
            if req is None:
                return False, None
            events = list(req.get("events") or req.get("Events") or [])
            episode, task, solution = extract_episode_payload(events)
            if not episode or not task:
                return False, None
            published_at = time.time()
            event_ids = tuple(_event_id(e) for e in events if _event_id(e))
            space_id = str(req.get("space_id") or req.get("SpaceID") or "")
            record = {
                "batch_id": batch_id,
                "commit_id": commit_id,
                "episode_id": episode,
                "task": task[:TASK_CAP],
                "solution": solution[:SOLUTION_CAP],
                "published_at": published_at,
                "event_ids": list(event_ids),
                "space_id": space_id,
            }
            with self._committed_path().open("a", encoding="utf-8") as f:
                f.write(json.dumps(record, ensure_ascii=False) + "\n")
            entry = self._entry_from_record(record)
            assert entry is not None
            self._by_batch[batch_id] = entry
            self._entries.append(entry)
            self._staged.pop(batch_id, None)
            return False, entry

    def recent(self, *, limit: int = 2, exclude_sessions: set[str] | None = None) -> list[OnlineEntry]:
        """Newest-first entries, skipping excluded session/episode ids.

        Re-reads committed.jsonl so a store instance used by recall sees
        commits written by the plane_server instance (same root, two objects).
        """
        exclude = exclude_sessions or set()
        with self._lock:
            self._reload_committed_unlocked()
            ordered = sorted(self._entries, key=lambda e: e.published_at, reverse=True)
        out: list[OnlineEntry] = []
        for entry in ordered:
            if entry.episode_id in exclude:
                continue
            out.append(entry)
            if len(out) >= limit:
                break
        return out

    def _reload_committed_unlocked(self) -> None:
        committed = self._committed_path()
        self._by_batch = {}
        self._entries = []
        if not committed.is_file():
            return
        with committed.open(encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                entry = self._entry_from_record(rec)
                if entry is None:
                    continue
                # last write wins per batch_id
                prev = self._by_batch.get(entry.batch_id)
                if prev is not None:
                    self._entries = [e for e in self._entries if e.batch_id != entry.batch_id]
                self._by_batch[entry.batch_id] = entry
                self._entries.append(entry)

    def get(self, episode_id: str) -> OnlineEntry | None:
        with self._lock:
            for entry in reversed(self._entries):
                if entry.episode_id == episode_id:
                    return entry
        return None

    def __len__(self) -> int:
        with self._lock:
            return len(self._entries)
