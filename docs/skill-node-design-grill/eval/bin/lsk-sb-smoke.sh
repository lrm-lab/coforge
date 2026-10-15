#!/bin/bash
# SkillsBench single-task smoke. COFORGE_EVAL_TASKS is required.
set -euo pipefail
EVAL=/home/zhoujie22/river2_0/skill-node-design-grill/eval
# shellcheck disable=SC1091
source "$EVAL/bin/lsk-common.sh"
export COFORGE_SKILLSBENCH_COLLAB_EVAL=1
export COFORGE_EVAL_TASKS="${COFORGE_EVAL_TASKS:-citation-check}"
export COFORGE_EVAL_ARMS="${COFORGE_EVAL_ARMS:-openviking}"
export COFORGE_EVAL_RESULT_DIR="${COFORGE_EVAL_RESULT_DIR:-$LSK_ROOT/benchmark/skillsbench-collab/result/lsk1-smoke}"
export COFORGE_EVAL_POLL_TIMEOUT_MS="${COFORGE_EVAL_POLL_TIMEOUT_MS:-2700000}"
mkdir -p "$COFORGE_EVAL_RESULT_DIR"
cd "$LSK_ROOT"
exec bun benchmark/skillsbench-collab/src/run.ts
