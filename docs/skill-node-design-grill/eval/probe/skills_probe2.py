#!/usr/bin/env python3
"""SkillsBench smoke probe v2.

Config 1 (pool / facts-only): one shared session, every SKILL.md is a fact
atom. No views (skills are retrieval surface, not influence graphs). Query per
task with real instruction keywords; measure right-task attribution and
cross-task confusion.

Config 2 (per-task / with view): one task gets its own session+ledger+view to
confirm single-view-per-session registers without the supersede warning.
"""
import hashlib
import json
import re
import tempfile
from pathlib import Path

from openviking.session.ao_ledger import AOLedger
from openviking.session.influence_projection import ProjectionRegistry
from openviking.session.influence_view import build_minimal_fallback_view
from openviking.session.retrieval_facade import (
    ForkBranchAdapter,
    HybridRetrievalFacade,
    InfluenceProjectionAdapter,
    SegmentAtomAdapter,
)

TASKS = [
    "3d-scan-calc",
    "citation-check",
    "azure-bgp-oscillation-route-leak",
    "bike-rebalance",
    "court-form-filling",
    "dapt-intrusion-detection",
]
ROOT = Path(
    "/home/zhoujie22/river2_0/.worktrees/cursor-ov-cm-impl/benchmark/skillsbench-collab/bench_data/tasks"
)
LABELS = ["skillsbench"]
STOP = set(
    "the a an to of in on at for with and or is are was were be been this that these those you your "
    "we they it its his her their i not no do does did can could would should must may might will "
    "when where why how what which who whom whose using use used needs need provide provides ensure "
    "from by as into out over under then than them there here all any each every some such only also "
    "task tasks following given file files output compute calculate analyze write create generate "
    "data using based must should properly correctly".split()
)

def instruction_of(path: Path) -> str:
    text = path.read_text(encoding="utf-8")
    m = re.search(r"^---\n.*?\n---\n", text, flags=re.S)
    return text[m.end():].strip() if m else text

def keywords(text: str, n: int = 4) -> list[str]:
    words = [w.strip(",.!?()'\"`:;").lower() for w in text.split()]
    seen, out = set(), []
    for w in words:
        if w not in STOP and len(w) > 4 and w not in seen:
            seen.add(w)
            out.append(w)
        if len(out) >= n:
            break
    return out

# ---------------- config 1: shared fact pool ----------------
work = Path(tempfile.mkdtemp(prefix="skills-probe2-"))
session_id = "skills-pool"
ledger = AOLedger(work / session_id, session_id)
ao_task: dict[str, str] = {}
ao_skill: dict[str, str] = {}
for task in TASKS:
    for sf in sorted((ROOT / task / "environment" / "skills").rglob("SKILL.md")):
        text = sf.read_text(encoding="utf-8")
        rec = ledger.append(
            action={"record_kind": "atom", "acl_labels": LABELS, "skill": sf.parent.name, "task": task, "text": text},
            observation={"synopsis": text[:400]},
            message_ref={"message_id": f"{task}:{sf.parent.name}"},
        )
        ao_task[rec.ao_id] = task
        ao_skill[rec.ao_id] = sf.parent.name
n_files = len(ao_task)
print(f"[pool] ingested {n_files} SKILL.md atoms into session {session_id}")

facade = HybridRetrievalFacade(
    fork_branch=ForkBranchAdapter(work),
    projection=InfluenceProjectionAdapter(ProjectionRegistry(work / "unused.jsonl")),
    segment_atom=SegmentAtomAdapter(work / session_id, session_id),
)
POOL_PROFILE = {"fork_branch": 0, "projection": 0, "segment_atom": 12}

print("\n=== config 1: cross-task skill retrieval on the fact pool ===")
for task in TASKS:
    instr = instruction_of(ROOT / task / "task.md")
    kws = keywords(instr)
    per_query = []
    for k in kws:
        res = facade.retrieve(k, principal_labels=LABELS, profile=POOL_PROFILE)
        hits = [(ao_task.get((c.source_pointer or {}).get("ao_id"), "?"), ao_skill.get((c.source_pointer or {}).get("ao_id"), "?")) for c in res.cards]
        per_query.append((k, hits))
    full = facade.retrieve(instr, principal_labels=LABELS, profile=POOL_PROFILE)
    flat = [h for _, hits in per_query for h in hits]
    right = sum(1 for t, _ in flat if t == task)
    print(f"\n{task}  kws={kws}")
    print(f"  full-instr: {len(full.cards)} cards")
    for k, hits in per_query:
        mark = " ".join(f"{t}/{s}" for t, s in hits)
        print(f"  kw '{k}': {len(hits)} hits -> {mark}")
    print(f"  keyword-union: right_task={right}/{len(flat)}")

# ---------------- config 2: per-task session with view ----------------
print("\n=== config 2: per-task session + single view (supersede sanity) ===")
task = "3d-scan-calc"
w2 = Path(tempfile.mkdtemp(prefix="skills-probe2b-"))
sid2 = f"task-{task}"
led2 = AOLedger(w2 / sid2, sid2)
rows, AO_TEXT = [], {}
for sf in sorted((ROOT / task / "environment" / "skills").rglob("SKILL.md")):
    text = sf.read_text(encoding="utf-8")
    rec = led2.append(
        action={"record_kind": "atom", "acl_labels": LABELS, "skill": sf.parent.name, "text": text},
        observation={"synopsis": text[:400]},
        message_ref={"message_id": f"{task}:{sf.parent.name}"},
    )
    AO_TEXT[rec.ao_id] = text
    rows.append({"ao_id": rec.ao_id, "sequence": rec.sequence, "participant_id": sf.parent.name,
                 "segment_id": f"{task}:{sf.parent.name}", "content_hash": hashlib.sha256(text.encode()).hexdigest()})
view = build_minimal_fallback_view({"session_id": sid2, "task_run_id": f"run-{task}", "ao_records": rows})
reg2 = ProjectionRegistry(w2 / "proj.jsonl")
cards = reg2.register(view, acl_labels=LABELS)
f2 = HybridRetrievalFacade(
    fork_branch=ForkBranchAdapter(w2),
    projection=InfluenceProjectionAdapter(reg2, views=[view], content_resolver=lambda ao: AO_TEXT.get(ao, "")),
    segment_atom=SegmentAtomAdapter(w2 / sid2, sid2),
)
instr = instruction_of(ROOT / task / "task.md")
for k in keywords(instr):
    res = f2.retrieve(k, principal_labels=LABELS)
    ch = {}
    for c in res.cards:
        ch[c.channel] = ch.get(c.channel, 0) + 1
    print(f"  kw '{k}': {len(res.cards)} cards channels={ch}")
print(f"  (cards registered={len(cards)}, no supersede warning expected above)")
