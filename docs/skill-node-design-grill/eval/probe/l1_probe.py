#!/usr/bin/env python3
"""L1 zero-LLM smoke probe: LoCoMo conv -> AO ledger -> fallback view -> facade.

Arms:
  A  Segment/Atom fact channel only (no view)
  B  + deterministic fallback InfluenceView projections (Block/Claim channel)
Checks: card shapes, channels/quotas, selection audit, ACL default-deny,
substring-exact text matching (full question vs keyword), evidence coverage.
"""
import hashlib
import json
import logging
import re
import random
import tempfile
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

from openviking.session.ao_ledger import AOLedger
from openviking.session.influence_projection import ProjectionRegistry
from openviking.session.influence_view import build_minimal_fallback_view
AO_TEXT = {}
from openviking.session.retrieval_facade import (
    ForkBranchAdapter,
    HybridRetrievalFacade,
    InfluenceProjectionAdapter,
    SegmentAtomAdapter,
)

DATA = "/home/zhoujie22/river2_0/evol_bench/LoCoMo/data/locomo/locomo10.json"
LABELS = ["locomo"]

conv = json.load(open(DATA))[0]
sample_id = conv["sample_id"]
work = Path(tempfile.mkdtemp(prefix="l1-probe-"))
session_id = f"locomo-{sample_id}"

# ---------- ingest: one AO record per chat message ----------
ledger = AOLedger(work / session_id, session_id)
sessions = sorted(
    ((k, v) for k, v in conv["conversation"].items() if re.fullmatch(r"session_\d+", k)),
    key=lambda kv: int(kv[0].split("_")[1]),
)
ao_rows, ao_to_dia, AO_TEXT = [], {}, {}
for sname, msgs in sessions:
    for m in msgs:
        rec = ledger.append(
            action={
                "record_kind": "atom",
                "acl_labels": LABELS,
                "speaker": m["speaker"],
                "text": m["text"],
                "dia_id": m["dia_id"],
                "locomo_session": sname,
            },
            observation={"synopsis": m["text"]},
            message_ref={"message_id": m["dia_id"]},
        )
        ao_rows.append(
            {
                "ao_id": rec.ao_id,
                "sequence": rec.sequence,
                "participant_id": m["speaker"],
                "segment_id": m["dia_id"],
                "content_hash": hashlib.sha256(m["text"].encode("utf-8")).hexdigest(),
            }
        )
        ao_to_dia[rec.ao_id] = m["dia_id"]
        AO_TEXT[rec.ao_id] = m["text"]
print(f"[ingest] {len(ao_rows)} AO records, ledger skipped_lines={ledger.skipped_line_count}")

# ---------- arm B: deterministic fallback view + projections ----------
view = build_minimal_fallback_view(
    {
        "session_id": session_id,
        "task_run_id": f"run-{sample_id}",
        "purpose": "post_run_index",
        "ao_records": ao_rows,
    }
)
print(f"[view] revision={view.revision_id} blocks={len(view.blocks)} claims={len(view.claims)} mode={view.construction_mode}")
registry = ProjectionRegistry(work / "projections.jsonl")
pcards = registry.register(view, acl_labels=LABELS)
print(f"[projection] cards={len(pcards)}")

facade = HybridRetrievalFacade(
    fork_branch=ForkBranchAdapter(work),
    projection=InfluenceProjectionAdapter(registry, views=[view], content_resolver=lambda ao: AO_TEXT.get(ao, "")),
    segment_atom=SegmentAtomAdapter(work / session_id, session_id),
)

# ---------- queries ----------
random.seed(0)
by_cat = {}
for q in conv["qa"]:
    by_cat.setdefault(q["category"], []).append(q)
picked = [by_cat[c][0] for c in sorted(by_cat)]  # one per category 1-5

def card_dia_ids(card):
    sp = card.source_pointer or {}
    ids = set()
    if card.channel == "fact":
        ao = sp.get("ao_id")
        if ao in ao_to_dia:
            ids.add(ao_to_dia[ao])
    else:
        for ref in sp.get("ao_refs", []) or []:
            ao = ref.get("ao_id") if isinstance(ref, dict) else None
            if ao in ao_to_dia:
                ids.add(ao_to_dia[ao])
    return ids

def run_query(label, text, labels=LABELS):
    res = facade.retrieve(text, principal_labels=labels)
    chans = {}
    for c in res.cards:
        chans[c.channel] = chans.get(c.channel, 0) + 1
    ev = set()
    for c in res.cards:
        ev |= card_dia_ids(c)
    print(f"\n[query:{label}] text={text[:70]!r}")
    print(f"  cards={len(res.cards)} channels={chans} truncated_by_rerank_clamp={res.truncated_by_rerank_clamp}")
    audit = res.selection_audit.to_dict() if res.selection_audit else None
    print(f"  selection_audit={json.dumps(audit, ensure_ascii=False)[:220]}")
    for q in picked:
        if text in (q["question"], keyword_for.get(q["question"], "")):
            gold = set(q["evidence"])
            print(f"  evidence: gold={sorted(gold)} covered={sorted(ev & gold)} -> {'HIT' if ev & gold else 'MISS'}")
    for c in res.cards[:3]:
        print(f"    card kind={c.kind} channel={c.channel} status={c.status_label} sel={c.selection_mode} ref={c.payload_ref[:60]}")
    return res

# keyword extraction: longest distinctive words from the question not in a stoplist
STOP = set("when did do does what which who whose where how why for a an the to of in on at is are was were be been her his their its she he they it i you we with about from that this these those likely would could can".split())
keyword_for = {}
for q in picked:
    words = [w.strip(",?.!()'\"").lower() for w in q["question"].split()]
    kw = [w for w in words if w not in STOP and len(w) > 4]
    keyword_for[q["question"]] = kw[0] if kw else ""

for q in picked:
    kw = keyword_for[q["question"]]
    run_query("full-question", q["question"])
    if kw:
        run_query("keyword", kw)

# ---------- ACL negative control ----------
print("\n[acl] wrong principal ->", end=" ")
res = facade.retrieve("", principal_labels=["someone-else"])
print(f"cards={len(res.cards)} (expect 0)")

# ---------- sample card dump ----------
res = facade.retrieve("", principal_labels=LABELS)
if res.cards:
    print("\n[card-dump] first fact + first projection card:")
    for c in res.cards:
        if c.channel == "fact":
            print(json.dumps(c.to_dict(), ensure_ascii=False)[:500]); break
    for c in res.cards:
        if c.channel != "fact":
            print(json.dumps(c.to_dict(), ensure_ascii=False)[:700]); break
print(f"\nworkdir={work}")
