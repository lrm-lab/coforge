"""Evo memory plane: influence-graph+fork retrieval over frozen EvoAgentBench views.

Same production surface as the R10 SkillsBench plane (openviking HybridRetrievalFacade
with fork/projection channels), with two evo adaptations:

- one family ``code-implementation`` for every evo session (the runner sends a
  single ``space-code-implementation-shared`` for the whole domain);
- placebo mode serves donor cards from the frozen SkillsBench views
  (views-r9m45): same count parity rule as R10 (donor fills to the count our
  would have returned), semantically unrelated domain.

Rendering/scoring helpers are reused from the R10 backend module.
"""
from __future__ import annotations

import os
import tempfile
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_R10 = _HERE.parent / "r10_memory_plane"

import importlib.util as _ilu
import sys as _sys

_spec = _ilu.spec_from_file_location("r10_retrieval_backend", _R10 / "retrieval_backend.py")
r10 = _ilu.module_from_spec(_spec)
_sys.modules[_spec.name] = r10
_spec.loader.exec_module(r10)

from openviking.session.causal_experiences import CausalExperiencesStore
from openviking.session.influence_projection import ProjectionRegistry
from openviking.session.influence_view import PURPOSE_POST_RUN_INDEX, ViewSupersedeIndex
from openviking.session.retrieval_facade import (
    ForkBranchAdapter,
    HybridRetrievalFacade,
    InfluenceProjectionAdapter,
    SegmentAtomAdapter,
)

EVO_FAMILY = "code-implementation"
DONOR_FAMILY = "sb_cybersecurity"  # sorted-first sb family: deterministic cross-domain donor
DONOR_VIEWS = Path(os.environ.get(
    "EVO_DONOR_VIEWS",
    str(_R10 / "views-r9m45"),
))
STAGING_ROOT = Path(os.environ.get("EVO_STAGING_ROOT", "/tmp/evo-plane/staging"))

# modes whose recall keeps the plane-1 synopsis rendering but gains the
# agent-driven exploration tool (plane_server gates /v1/memory-explore on it).
# dense-online also exposes explore so search can surface same-run publishes.
EXPLORE_MODES = ("explore", "densexplore", "dense-online")
ONLINE_MIX_CAP = 2


def _resolver():
    global _PAYLOAD
    if _PAYLOAD is None:
        from payload_resolver import PayloadResolver

        _PAYLOAD = PayloadResolver(STAGING_ROOT)
    return _PAYLOAD


def _online_store():
    global _ONLINE
    if _ONLINE is None:
        from online_store import OnlineStore

        _ONLINE = OnlineStore()
    return _ONLINE


_PAYLOAD = None
_ONLINE = None


def fuse_dense_online(
    frozen_items: list,
    online_entries: list,
    *,
    max_results: int,
    space_id: str,
) -> list:
    """Reserve up to ONLINE_MIX_CAP newest online slots; fill the rest from frozen."""
    from online_store import OnlineEntry

    exclude = {getattr(it, "session_id", "") for it in frozen_items}
    online: list[OnlineEntry] = [
        e for e in online_entries if e.episode_id not in exclude
    ][:ONLINE_MIX_CAP]
    n_online = min(len(online), max_results, ONLINE_MIX_CAP)
    n_frozen = max_results - n_online
    items = list(frozen_items[:n_frozen])
    for entry in online[:n_online]:
        items.append(
            r10.RecallItem(
                content=entry.task,
                source_space_id=space_id or entry.space_id or "space-code-implementation-shared",
                memory_version=1,
                citation_id=f"online-{entry.episode_id}",
                evidence_batch_id=entry.batch_id,
                event_ids=list(entry.event_ids) or [f"online-{entry.episode_id}"],
                score=1.0,
                card_kind="online",
                view_revision_id="",
                session_id=entry.episode_id,
            )
        )
    return items


class FamilyBackend(r10.RetrievalBackend):
    """RetrievalBackend with an injected session->family map and family set.

    The R10 class resolves families through module-level hooks bound to the
    SkillsBench corpus; everything below __init__ is family-agnostic and is
    inherited untouched (rendering, scoring, facade shape, channel counts).
    """

    def __init__(self, views_root: Path, families: tuple[str, ...]) -> None:
        # deliberately not calling super().__init__: same body, parameterized
        self.views_root = views_root
        report = views_root / "report.json"
        compliant = r10._compliant_sessions(report)
        index = ViewSupersedeIndex(views_root / "views.json")
        all_revs = index.revisions_for_purpose(PURPOSE_POST_RUN_INDEX)
        self._revision_by_id: dict = {}
        by_family: dict[str, list] = {f: [] for f in families}
        for rev in all_revs:
            if rev.session_id not in compliant:
                continue
            by_family[families[0]].append(rev)
            self._revision_by_id[rev.revision_id] = rev
        self._by_family = by_family
        self._work = Path(tempfile.mkdtemp(prefix="evo-plane-"))
        self._facades: dict[str, HybridRetrievalFacade] = {}
        self._build_facades()


class EvoBackend:
    def __init__(self, views_root: Path, online_store=None) -> None:
        self.evo = FamilyBackend(views_root, (EVO_FAMILY,))
        self.donor = FamilyBackend(DONOR_VIEWS, tuple(r10.FAMILY_ORDER))
        self._online = online_store

    def _outcome(self, **kw) -> r10.RecallOutcome:
        return r10.RecallOutcome(**kw)

    def _store(self):
        return self._online if self._online is not None else _online_store()

    def _dense_items(self, *, query: str, space_ids: list[str], max_results: int):
        """BM25-routed frozen cards with verbatim staging task payloads (session-deduped)."""
        pool = self.evo._retrieve_cards(EVO_FAMILY, query, max_results * 4)
        cards, seen_sessions = [], set()
        for card in pool:
            session = str(card.source_pointer.get("session_id") or "")
            if not session or session in seen_sessions:
                continue
            seen_sessions.add(session)
            cards.append(card)
            if len(cards) >= max_results:
                break
        resolver = _resolver()
        items = []
        for card in cards:
            session = str(card.source_pointer.get("session_id") or "")
            task = resolver.task(session)
            if not task:
                continue  # no payload resolvable: refuse the slot silently
            items.append(r10.RecallItem(
                content=task,
                source_space_id=space_ids[0] if space_ids else "space-code-implementation-shared",
                memory_version=self.evo._memory_version(card),
                citation_id=card.payload_ref,
                evidence_batch_id=str(card.source_pointer.get("view_revision_id") or ""),
                event_ids=self.evo._event_ids(card),
                score=self.evo._score(card),
                card_kind=card.kind,
                view_revision_id=str(card.source_pointer.get("view_revision_id") or ""),
                session_id=session,
            ))
        return items, cards

    def recall(self, *, query: str, space_ids: list[str], max_results: int, mode: str) -> r10.RecallOutcome:
        import time

        t0 = time.perf_counter()
        if mode == "cold":
            return self._outcome(
                items=[], degradation_state="empty",
                channel_counts={"fork": 0, "projection": 0, "subgraph": 0},
                family_scope=None, retrieve_family=None, placebo_donor_family=None,
                filter_reason="mode_cold", elapsed_ms=(time.perf_counter() - t0) * 1000,
            )
        if mode in ("dense", "densexplore", "dense-online"):
            # GMS-mechanism replication: BM25 over view blocks as the router,
            # but the card payload is the cited session's verbatim task text
            # (read back through the staging transcript), one distinct train
            # task per slot — the greenfield recalls were 5 verbatim neighbor
            # task statements, mean ~2k chars each.
            # dense-online additionally mixes newest same-run publishes.
            items, cards = self._dense_items(
                query=query, space_ids=space_ids, max_results=max_results,
            )
            if mode == "dense-online":
                space = space_ids[0] if space_ids else "space-code-implementation-shared"
                online = self._store().recent(
                    limit=ONLINE_MIX_CAP,
                    exclude_sessions={it.session_id for it in items},
                )
                items = fuse_dense_online(
                    items, online, max_results=max_results, space_id=space,
                )
                state = "complete" if items else "empty"
                return self._outcome(
                    items=items, degradation_state=state,
                    channel_counts=r10.RetrievalBackend._channel_counts(self.evo, cards),
                    family_scope=space_ids[0] if space_ids else None,
                    retrieve_family=EVO_FAMILY,
                    placebo_donor_family=None,
                    filter_reason="dense-online" if items else "no_payload",
                    elapsed_ms=(time.perf_counter() - t0) * 1000,
                )
            state = "complete" if items else "empty"
            return self._outcome(
                items=items, degradation_state=state,
                channel_counts=r10.RetrievalBackend._channel_counts(self.evo, cards),
                family_scope=space_ids[0] if space_ids else None,
                retrieve_family=EVO_FAMILY,
                placebo_donor_family=None,
                filter_reason=f"mode_{mode}" if items else "no_payload",
                elapsed_ms=(time.perf_counter() - t0) * 1000,
            )
        our_cards = self.evo._retrieve_cards(EVO_FAMILY, query, max_results)
        cards = our_cards
        donor_used: str | None = None
        retrieve_family = EVO_FAMILY
        if mode == "placebo":
            target_n = len(our_cards) if our_cards else max_results
            donor_used = DONOR_FAMILY
            cards = self.donor._retrieve_cards(DONOR_FAMILY, query, target_n)
            if len(cards) < target_n:
                seen = {c.payload_ref for c in cards}
                for extra in self.donor._retrieve_cards(DONOR_FAMILY, "", target_n):
                    if extra.payload_ref in seen:
                        continue
                    cards.append(extra)
                    seen.add(extra.payload_ref)
                    if len(cards) >= target_n:
                        break
            cards = cards[:target_n]
            retrieve_family = donor_used
        items = []
        for card in cards:
            backend = self.donor if mode == "placebo" else self.evo
            items.append(r10.RecallItem(
                content=backend._render_content(card),
                source_space_id=space_ids[0] if space_ids else "space-code-implementation-shared",
                memory_version=backend._memory_version(card),
                citation_id=card.payload_ref,
                evidence_batch_id=str(card.source_pointer.get("view_revision_id") or ""),
                event_ids=backend._event_ids(card),
                score=backend._score(card),
                card_kind=card.kind,
                view_revision_id=str(card.source_pointer.get("view_revision_id") or ""),
                session_id=getattr(card, "session_id", ""),
            ))
        state = "complete" if items else "empty"
        return self._outcome(
            items=items, degradation_state=state,
            channel_counts=r10.RetrievalBackend._channel_counts(self.evo, cards),
            family_scope=space_ids[0] if space_ids else None,
            retrieve_family=retrieve_family,
            placebo_donor_family=donor_used,
            filter_reason="ok" if items else "no_cards",
            elapsed_ms=(time.perf_counter() - t0) * 1000,
        )

    # ---- agent-driven exploration (coforge ADR 0052-E shape, evo adaptation) ----
    # The plane-1 forensics: passive synopsis cards carry no transferable
    # payload. The exploration entry lets the task agent pull payloads on
    # demand: search routes via block BM25 (same router as recall), expand
    # reads the raw payload back through the staging transcript, neighbors
    # re-routes from a cited task's own text. Deviations from 0052-E, kept
    # for the bench: no close/Memory-Offer round (content serves directly
    # in the tool result), no idempotency ledger; bounded ops + cited-result
    # budgets + per-caller TTL stay.

    def _cards_by_session(self, query: str, limit: int, exclude: str | None = None):
        pool = self.evo._retrieve_cards(EVO_FAMILY, query, limit * 4)
        out, seen = [], set()
        for card in pool:
            session = str(card.source_pointer.get("session_id") or "")
            if not session or session in seen or session == exclude:
                continue
            seen.add(session)
            out.append(card)
            if len(out) >= limit:
                break
        return out

    def explore_search(self, query: str, n: int = 5, mode: str | None = None) -> list[dict]:
        out = []
        for card in self._cards_by_session(query, n):
            session = str(card.source_pointer.get("session_id") or "")
            out.append({
                "citation_id": card.payload_ref,
                "session_id": session,
                "kind": "block",
                "summary": self.evo._render_content(card)[:280],
                "score": self.evo._score(card),
            })
        if mode == "dense-online":
            seen = {row["session_id"] for row in out}
            online = self._store().recent(limit=ONLINE_MIX_CAP, exclude_sessions=seen)
            n_online = min(len(online), n, ONLINE_MIX_CAP)
            n_frozen = n - n_online
            merged = out[:n_frozen]
            for entry in online[:n_online]:
                merged.append({
                    "citation_id": f"online-{entry.episode_id}",
                    "session_id": entry.episode_id,
                    "kind": "online",
                    "summary": entry.task[:280],
                    "score": 1.0,
                })
            return merged
        return out

    def explore_expand(self, session_id: str, kind: str = "task") -> dict:
        resolver = _resolver()
        if not resolver.has(session_id):
            return {"error": f"unknown session {session_id}"}
        if kind == "task":
            return {"session_id": session_id, "kind": "task", "text": resolver.task(session_id)}
        if kind == "solution":
            return {"session_id": session_id, "kind": "solution", "text": resolver.solution(session_id)}
        if kind == "both":
            return {
                "session_id": session_id, "kind": "both",
                "task_text": resolver.task(session_id),
                "solution_text": resolver.solution(session_id),
            }
        return {"error": f"unknown kind {kind} (task|solution|both)"}

    def explore_neighbors(self, session_id: str, n: int = 5) -> list[dict]:
        resolver = _resolver()
        anchor = resolver.task(session_id)
        if not anchor:
            return [{"error": f"unknown session {session_id}"}]
        out = []
        for card in self._cards_by_session(anchor[:1500], n, exclude=session_id):
            other = str(card.source_pointer.get("session_id") or "")
            out.append({
                "citation_id": card.payload_ref,
                "session_id": other,
                "kind": "block",
                "summary": self.evo._render_content(card)[:280],
                "score": self.evo._score(card),
            })
        return out
