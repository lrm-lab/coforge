#!/bin/bash
# Offline EvoAgentBench grading (09-09 frozen env). Dedup attempts first.
# usage: lsk-evo-grade.sh <attempts.jsonl> <output-dir>
set -euo pipefail
ATTEMPTS=${1:?attempts.jsonl}
OUT=${2:?output-dir}
EVAL=/home/zhoujie22/river2_0/skill-node-design-grill/eval
MANIFEST=${COFORGE_EVAL_MANIFEST:-/home/zhoujie22/river2_0/evol_bench/EvoAgentBench/data/evo-code-implementation.jsonl}
GRADE=/tmp/evo-grading-0909
if [ ! -d "$GRADE" ]; then
  echo "missing $GRADE; rebuild per evol_bench/EvoAgentBench/REPRODUCE.md §3" >&2
  exit 1
fi
mkdir -p "$OUT"
DEDUP="$OUT/attempts-dedup.jsonl"
python3 - <<PY
import json
from pathlib import Path
rows={}
for line in Path("$ATTEMPTS").read_text().splitlines():
    if not line.strip():
        continue
    o=json.loads(line)
    key=(o.get("arm"), o.get("episode_id"))
    rows[key]=line
Path("$DEDUP").write_text("".join(v+"\n" for v in rows.values()))
print("dedup", len(rows), "->", "$DEDUP")
PY
LCB_PY="${LCB_PYTHON:-}"
if [ -z "$LCB_PY" ]; then
  LCB_PY=$(ls -d /tmp/evo-grading-0909/.venv/bin/python /tmp/lcb-venv/bin/python "$HOME"/lcb-venv/bin/python 2>/dev/null | head -1 || true)
fi
if [ -z "$LCB_PY" ]; then
  echo "set LCB_PYTHON to the LiveCodeBench python" >&2
  exit 1
fi
export PYTHONPATH="$GRADE"
python3 -m memory_bench.grading \
  --attempts "$DEDUP" \
  --manifest "$MANIFEST" \
  --lcb-python "$LCB_PY" \
  --bridge "$GRADE/graders/lcb_grade.py" \
  --output-dir "$OUT"
