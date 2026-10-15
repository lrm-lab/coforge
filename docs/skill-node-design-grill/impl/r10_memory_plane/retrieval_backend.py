"""R10 memory plane: production HybridRetrievalFacade over frozen R9m views."""

from __future__ import annotations

import json
import re
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

_IMPL = Path(__file__).resolve().parent
_OPENVIKING = _IMPL.parents[1].parent / "OpenViking"
if str(_OPENVIKING) not in sys.path:
    sys.path.insert(0, str(_OPENVIKING))

from openviking.session.causal_experiences import CausalExperiencesStore
from openviking.session.influence_projection import ProjectionRegistry
from openviking.session.influence_view import (
    PURPOSE_POST_RUN_INDEX,
    InfluenceClaim,
    InfluenceViewRevision,
    ViewSupersedeIndex,
)
from openviking.session.retrieval_facade import (
    ForkBranchAdapter,
    HybridRetrievalFacade,
    InfluenceProjectionAdapter,
    RetrievalCard,
    SegmentAtomAdapter,
)

ISOLATED_SHARED_RE = re.compile(r"-(test|train)-\d+-shared$")

WORKSPACE_LABELS = ("sb-skillsbench",)
RETRIEVAL_PROFILE: dict[str, Any] = {
    "fork_branch": 4,
    "projection": 8,
    "segment_atom": 0,
    "provisional_slots": 4,
    "rank_mode": "bm25",
}

FAMILY_ORDER = (
    "sb_cybersecurity",
    "sb_finance-economics",
    "sb_industrial-physical-systems",
)

SB_FULL = _IMPL.parents[1].parent / "evol_bench" / "SkillsBench" / "data" / "sb-full.jsonl"


def _family_shared_scope(space_ids: list[str]) -> str | None:
    for sid in space_ids:
        if sid.endswith("-shared") and not ISOLATED_SHARED_RE.search(sid):
            return sid
    return None


def _family_from_space(space_id: str) -> str | None:
    """Runner space ids use hyphens: space-sb-industrial-physical-systems-shared."""
    if not space_id.startswith("space-") or not space_id.endswith("-shared"):
        return None
    inner = space_id.removeprefix("space-").removesuffix("-shared")
    if not inner:
        return None
    if inner.startswith("sb-"):
        return "sb_" + inner.removeprefix("sb-")
    return inner


def _next_family(family_id: str) -> str:
    ordered = sorted(FAMILY_ORDER)
    if family_id not in ordered:
        return ordered[0]
    idx = ordered.index(family_id)
    return ordered[(idx + 1) % len(ordered)]


def _episode_family_lookup() -> dict[str, str]:
    """sb-full episode_id (sb-task) -> family_id."""
    by_episode_id: dict[str, str] = {}
    if SB_FULL.is_file():
        for line in SB_FULL.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            ep = str(row.get("episode_id", ""))
            fam = str(row.get("family_id", ""))
            if ep and fam:
                by_episode_id[ep] = fam
    return by_episode_id


def _family_for_session(session_id: str, episode_families: dict[str, str]) -> str | None:
    if session_id in episode_families:
        return episode_families[session_id]
    if "-sb-" in session_id:
        sb_ep = session_id.split("-", 1)[1]
        if sb_ep.startswith("sb-"):
            return episode_families.get(sb_ep)
    return None


def _compliant_sessions(report_path: Path) -> set[str]:
    data = json.loads(report_path.read_text(encoding="utf-8"))
    out: set[str] = set()
    for item in data.get("episodes", []):
        if item.get("compliant"):
            out.add(str(item["episode_id"]))
    return out


@dataclass(frozen=True)
class RecallItem:
    content: str
    source_space_id: str
    memory_version: int
    citation_id: str
    evidence_batch_id: str
    event_ids: list[str]
    score: float
    card_kind: str
    view_revision_id: str
    session_id: str


@dataclass
class RecallOutcome:
    items: list[RecallItem]
    degradation_state: str
    channel_counts: dict[str, int]
    family_scope: str | None
    retrieve_family: str | None
    placebo_donor_family: str | None
    filter_reason: str
    elapsed_ms: float


class RetrievalBackend:
    def __init__(self, views_root: Path) -> None:
        self.views_root = views_root
        report = views_root / "report.json"
        compliant = _compliant_sessions(report)
        index = ViewSupersedeIndex(views_root / "views.json")
        all_revs = index.revisions_for_purpose(PURPOSE_POST_RUN_INDEX)
        episode_families = _episode_family_lookup()
        self._revision_by_id: dict[str, InfluenceViewRevision] = {}
        by_family: dict[str, list[InfluenceViewRevision]] = {f: [] for f in FAMILY_ORDER}
        for rev in all_revs:
            if rev.session_id not in compliant:
                continue
            fam = _family_for_session(rev.session_id, episode_families)
            if fam is None or fam not in by_family:
                continue
            by_family[fam].append(rev)
            self._revision_by_id[rev.revision_id] = rev
        self._by_family = by_family
        self._work = Path(tempfile.mkdtemp(prefix="r10-plane-"))
        self._facades: dict[str, HybridRetrievalFacade] = {}
        self._build_facades()

    def _build_facades(self) -> None:
        for family, revisions in self._by_family.items():
            if not revisions:
                continue
            registry = ProjectionRegistry(self._work / f"projections-{family}.jsonl")
            views = list(revisions)
            for rev in views:
                registry.register(rev, acl_labels=WORKSPACE_LABELS)
            store = CausalExperiencesStore(self._work / f"forks-{family}")
            facade = HybridRetrievalFacade(
                fork_branch=ForkBranchAdapter(self._work / f"forkstore-{family}", store),
                projection=InfluenceProjectionAdapter(registry, views=views),
                segment_atom=SegmentAtomAdapter(self._work / f"atom-{family}", "empty"),
                fact_lane_paused=True,
            )
            self._facades[family] = facade

    def _render_content(self, card: RetrievalCard) -> str:
        if card.text:
            return card.text
        pointer = card.source_pointer
        rev_id = str(pointer.get("view_revision_id") or "")
        rev = self._revision_by_id.get(rev_id)
        entity = str(pointer.get("block_or_claim_id") or "")
        if rev is None:
            return card.payload_ref
        if card.kind == "block_projection":
            for block in rev.blocks:
                if block.block_id == entity:
                    return (
                        f"{block.summary}\n"
                        f"input: {block.input}\n"
                        f"output: {block.output}"
                    )
        if card.kind == "claim_projection":
            for claim in rev.claims:
                if claim.claim_id == entity:
                    return _claim_text(claim)
        carried = pointer.get("carried_artifact")
        downstream = pointer.get("downstream_effect")
        parts = [p for p in (carried, downstream) if isinstance(p, str) and p]
        if parts:
            return "\n".join(parts)
        return card.payload_ref

    def _memory_version(self, card: RetrievalCard) -> int:
        rev_id = str(card.source_pointer.get("view_revision_id") or "")
        rev = self._revision_by_id.get(rev_id)
        if rev is None:
            return 1
        # stable small int from revision id for logging
        return abs(hash(rev.revision_id)) % (2**31 - 1) or 1

    def _score(self, card: RetrievalCard) -> float:
        breakdown = card.score_breakdown
        if isinstance(breakdown, dict):
            for key in ("bm25", "hybrid", "fused"):
                val = breakdown.get(key)
                if isinstance(val, (int, float)):
                    return float(val)
        return 0.0

    def _event_ids(self, card: RetrievalCard) -> list[str]:
        rev_id = str(card.source_pointer.get("view_revision_id") or "")
        rev = self._revision_by_id.get(rev_id)
        entity = str(card.source_pointer.get("block_or_claim_id") or "")
        if rev is None:
            return []
        if card.kind == "block_projection":
            for block in rev.blocks:
                if block.block_id == entity:
                    return [ref.ao_id for ref in block.source_refs[:3]]
        if card.kind == "claim_projection":
            for claim in rev.claims:
                if claim.claim_id == entity:
                    refs = list(claim.source_evidence_refs) + list(claim.target_evidence_refs)
                    return [r.ao_id for r in refs[:3] if getattr(r, "ao_id", None)]
        return []

    def _channel_counts(self, cards: list[RetrievalCard]) -> dict[str, int]:
        counts = {"fork": 0, "projection": 0, "subgraph": 0}
        for card in cards:
            if card.kind in {"fork", "branch"}:
                counts["fork"] += 1
            elif card.kind in {"block_projection", "claim_projection"}:
                counts["projection"] += 1
        return counts

    def _retrieve_cards(self, family: str, query: str, limit: int) -> list[RetrievalCard]:
        facade = self._facades.get(family)
        if facade is None:
            return []
        result = facade.retrieve(query, principal_labels=WORKSPACE_LABELS, profile=RETRIEVAL_PROFILE)
        return list(result.cards[:limit])

    def recall(
        self,
        *,
        query: str,
        space_ids: list[str],
        max_results: int,
        mode: str,
    ) -> RecallOutcome:
        import time

        t0 = time.perf_counter()
        family_space = _family_shared_scope(space_ids)
        if mode == "cold":
            elapsed = (time.perf_counter() - t0) * 1000
            return RecallOutcome(
                items=[],
                degradation_state="empty",
                channel_counts={"fork": 0, "projection": 0, "subgraph": 0},
                family_scope=family_space,
                retrieve_family=None,
                placebo_donor_family=None,
                filter_reason="mode_cold",
                elapsed_ms=elapsed,
            )
        if family_space is None:
            elapsed = (time.perf_counter() - t0) * 1000
            return RecallOutcome(
                items=[],
                degradation_state="empty",
                channel_counts={"fork": 0, "projection": 0, "subgraph": 0},
                family_scope=None,
                retrieve_family=None,
                placebo_donor_family=None,
                filter_reason="non_family_space",
                elapsed_ms=elapsed,
            )
        family_id = _family_from_space(family_space)
        if family_id is None or family_id not in self._facades:
            elapsed = (time.perf_counter() - t0) * 1000
            return RecallOutcome(
                items=[],
                degradation_state="empty",
                channel_counts={"fork": 0, "projection": 0, "subgraph": 0},
                family_scope=family_space,
                retrieve_family=family_id,
                placebo_donor_family=None,
                filter_reason="family_no_memory_coverage",
                elapsed_ms=elapsed,
            )
        donor: str | None = None
        retrieve_family = family_id
        cards: list[RetrievalCard] = []
        if mode == "placebo":
            donor = _next_family(family_id)
            our_cards = self._retrieve_cards(family_id, query, max_results)
            target_n = len(our_cards) if our_cards else max_results
            cards = self._retrieve_cards(donor, query, target_n)
            if len(cards) < target_n:
                seen = {c.payload_ref for c in cards}
                for extra in self._retrieve_cards(donor, "", target_n):
                    if extra.payload_ref in seen:
                        continue
                    cards.append(extra)
                    seen.add(extra.payload_ref)
                    if len(cards) >= target_n:
                        break
            cards = cards[:target_n]
            retrieve_family = donor
        else:
            cards = self._retrieve_cards(retrieve_family, query, max_results)
        items: list[RecallItem] = []
        for card in cards:
            items.append(
                RecallItem(
                    content=self._render_content(card),
                    source_space_id=family_space,
                    memory_version=self._memory_version(card),
                    citation_id=card.payload_ref,
                    evidence_batch_id=str(card.source_pointer.get("view_revision_id") or ""),
                    event_ids=self._event_ids(card),
                    score=self._score(card),
                    card_kind=card.kind,
                    view_revision_id=str(card.source_pointer.get("view_revision_id") or ""),
                    session_id=str(card.source_pointer.get("session_id") or ""),
                )
            )
        state = "complete" if items else "empty"
        elapsed = (time.perf_counter() - t0) * 1000
        return RecallOutcome(
            items=items,
            degradation_state=state,
            channel_counts=self._channel_counts(cards),
            family_scope=family_space,
            retrieve_family=retrieve_family,
            placebo_donor_family=donor,
            filter_reason="ok" if items else "retrieve_zero_hits",
            elapsed_ms=elapsed,
        )


def _claim_text(claim: InfluenceClaim) -> str:
    return (
        f"carried_artifact: {claim.carried_artifact}\n"
        f"downstream_effect: {claim.downstream_effect}\n"
        f"relation_type: {claim.relation_type}"
    )
