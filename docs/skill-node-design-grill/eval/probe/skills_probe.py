#!/usr/bin/env python3
"""SkillsBench smoke probe: skill files -> AO ledger -> fallback view -> facade.

Per picked task: ingest every environment/skills/**/SKILL.md as one AO record,
build one fallback view per task, then query with (a) the full task
instruction, (b) instruction keywords, (c) a skill-domain term. Checks: does
retrieval surface the right task's skill; cross-task confusion; default
6/4/2 profile vs a skill-oriented profile.
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
    "from by as into out over under then than them there here all any each every some such only also".split()
)

def instruction_of(task_md: str) -> str:
    parts = task_md.split("\n---\n", 2)
    return parts[2].strip() if len(parts) == 3 else task_md

def keywords(text: str, n: int = 3) -> list[str]:
    words = [w.strip(",.!?()'\"`:;").lower() for w in text.split()]
    seen, out = set(), []
    for w in words:
        if w not in STOP and len(w) > 4 and w not in seen:
            seen.add(w)
            out.append(w)
        if len(out) >= n:
            break
    return out

work = Path(tempfile.mkdtemp(prefix="skills-probe-"))
session_id = "skillsbench-pool"
ledger = AOLedger(work / session_id, session_id)
AO_TEXT: dict[str, str] = {}
ao_task: dict[str, str] = {}
views = []
per_task_rows: dict[str, list[dict]] = {}

for task in TASKS:
    tdir = ROOT / task
    skill_files = sorted((tdir / "environment" / "skills").rglob("SKILL.md"))
    instr = instruction_of((tdir / "task.md").read_text(encoding="utf-8"))
    rows = []
    for sf in skill_files:
        text = sf.read_text(encoding="utf-8")
        rec = ledger.append(
            action={
                "record_kind": "atom",
                "acl_labels": LABELS,
                "skill": sf.parent.name,
                "task": task,
                "text": text,
            },
            observation={"synopsis": text[:400]},
            message_ref={"message_id": f"{task}:{sf.parent.name}"},
        )
        AO_TEXT[rec.ao_id] = text
        ao_task[rec.ao_id] = task
        rows.append(
            {
                "ao_id": rec.ao_id,
                "sequence": rec.sequence,
                "participant_id": sf.parent.name,
                "segment_id": f"{task}:{sf.parent.name}",
                "content_hash": hashlib.sha256(text.encode("utf-8")).hexdigest(),
            }
        )
    view = build_minimal_fallback_view(
        {"session_id": session_id, "task_run_id": f"run-{task}", "ao_records": rows}
    )
    views.append(view)
    per_task_rows[task] = rows
    print(f"[ingest] {task}: {len(rows)} skill file(s), {len(instr)} instr chars")

registry = ProjectionRegistry(work / "projections.jsonl")
n_cards = 0
for v in views:
    n_cards += len(registry.register(v, acl_labels=LABELS))
print(f"[projection] cards={n_cards}")

facade = HybridRetrievalFacade(
    fork_branch=ForkBranchAdapter(work),
    projection=InfluenceProjectionAdapter(registry, views=views, content_resolver=lambda ao: AO_TEXT.get(ao, "")),
    segment_atom=SegmentAtomAdapter(work / session_id, session_id),
)
SKILL_PROFILE = {"fork_branch": 0, "projection": 4, "segment_atom": 8}

def attribution(res):
    per = {}
    for c in res.cards:
        if c.channel == "fact":
            t = ao_task.get((c.source_pointer or {}).get("ao_id"), "?")
        else:
            bid = (c.source_pointer or {}).get("block_or_claim_id") or "?"
            t = bid.split(":")[0].replace("fallback-", "", 1)
        per[t] = per.get(t, 0) + 1
    return per

for task in TASKS:
    instr = instruction_of((ROOT / task / "task.md").read_text(encoding="utf-8"))
    kws = keywords(instr)
    print(f"\n### {task}  keywords={kws}")
    for label, profile in [
        ("full-instr", None),
        ("keywords-union", None),
        ("keywords-union+skillprofile", SKILL_PROFILE),
    ]:
        if label == "full-instr":
            results = [facade.retrieve(instr, principal_labels=LABELS, profile=profile)]
        else:
            # substring matcher has no multi-term OR: query each keyword and union
            results = [facade.retrieve(k, principal_labels=LABELS, profile=profile) for k in kws]
        att, total, right = {}, 0, 0
        for res in results:
            a = attribution(res)
            total += len(res.cards)
            for k, v in a.items():
                att[k] = att.get(k, 0) + v
        right = att.get(task, 0)
        wrong = total - right
        print(f"  [{label}] cards={total} right_task={right} other_task={wrong} attrib={att}")
