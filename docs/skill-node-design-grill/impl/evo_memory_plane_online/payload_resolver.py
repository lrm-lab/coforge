"""Resolve frozen-view sessions back to their raw payloads (task text, final solution).

The evo-plane-1 forensics showed the GMS greenfield gain lived in payload
density: recalls were ~2k-char verbatim train task statements, while view
blocks carry 1-2 sentence synopses. The raw payloads still exist on disk in
the views-build staging transcripts (one ``2*.jsonl`` pi session per episode
plus ``sb-task.json``), and every view block carries ``segment_ref.session_id``
naming that episode. This module is the read-back hop: session_id -> payload.

Task extraction: the transcript's first user message wraps the task as
``Room message (untrusted content):\n<task>\n\nRecalled context (state=...):...``
(warm-train episodes appended their own recalls; the task always comes first).
Solution extraction: the last assistant message text, capped — it carries the
final approach + code block the episode published.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

_UNTRUSTED = "Room message (untrusted content):"
_RECALL_MARK = "\nRecalled context (state="
TASK_CAP = 4000
SOLUTION_CAP = 3500


def strip_task_wrapper(text: str) -> str:
    """Peel host wraps around a published human room message / transcript user turn.

    Invariant: task body always precedes any appended ``Recalled context`` block;
    the untrusted-content prefix is optional (absent in GMS state dumps, present
    in pi transcript user turns).
    """
    if text.startswith(_UNTRUSTED):
        text = text[len(_UNTRUSTED) :].lstrip("\n")
    at = text.find(_RECALL_MARK)
    if at != -1:
        text = text[:at]
    return text.strip()


def _texts(content) -> list[str]:
    if isinstance(content, str):
        return [content]
    if isinstance(content, list):
        return [b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"]
    return []


def _first_user_task(transcript: Path) -> str:
    with transcript.open(encoding="utf-8") as fh:
        for line in fh:
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if record.get("type") != "message":
                continue
            inner = record.get("message") or {}
            if inner.get("role") != "user":
                continue
            text = "".join(_texts(inner.get("content")))
            return strip_task_wrapper(text)
    return ""


def _last_assistant(transcript: Path) -> str:
    last = ""
    with transcript.open(encoding="utf-8") as fh:
        for line in fh:
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if record.get("type") != "message":
                continue
            inner = record.get("message") or {}
            if inner.get("role") == "assistant":
                candidate = "".join(_texts(inner.get("content"))).strip()
                if candidate:
                    last = candidate
    return last


def _session_id_of(dirname: str) -> str:
    # staging dirs are the raw session ids (e.g. 0001-1883-c)
    return dirname


class PayloadResolver:
    def __init__(self, staging_root: Path) -> None:
        self.root = Path(staging_root)
        self._cache: dict[str, dict] = {}
        self._load()

    def _load(self) -> None:
        for entry in sorted(self.root.iterdir()):
            if not entry.is_dir():
                continue
            session = _session_id_of(entry.name)
            transcripts = sorted(entry.glob("2*.jsonl"))
            if not transcripts:
                continue
            task = _first_user_task(transcripts[0])
            solution = _last_assistant(transcripts[0])
            if not task:
                continue
            self._cache[session] = {
                "session_id": session,
                "task": task[:TASK_CAP],
                "task_chars": len(task),
                "solution": solution[:SOLUTION_CAP],
                "solution_chars": len(solution),
            }

    def sessions(self) -> list[str]:
        return sorted(self._cache)

    def has(self, session_id: str) -> bool:
        return session_id in self._cache

    def task(self, session_id: str) -> str | None:
        entry = self._cache.get(session_id)
        return entry["task"] if entry else None

    def solution(self, session_id: str) -> str | None:
        entry = self._cache.get(session_id)
        return entry["solution"] if entry else None

    def stats(self) -> dict:
        tasks = [e["task_chars"] for e in self._cache.values()]
        sols = [e["solution_chars"] for e in self._cache.values()]
        return {
            "sessions": len(self._cache),
            "task_chars_mean": round(sum(tasks) / len(tasks), 1) if tasks else 0,
            "task_chars_max": max(tasks) if tasks else 0,
            "solution_nonempty": sum(1 for s in sols if s > 0),
        }


_TASK_HEAD = re.compile(r"You are an expert Python programmer", re.I)


def looks_like_task(text: str) -> bool:
    return bool(_TASK_HEAD.search(text[:400]))
