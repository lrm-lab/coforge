#!/bin/bash
# LongMemEval one-sample smoke on the isolated learned-skill stack.
set -euo pipefail
EVAL=/home/zhoujie22/river2_0/skill-node-design-grill/eval
# shellcheck disable=SC1091
source "$EVAL/bin/lsk-common.sh"
export COFORGE_LME_COLLAB_EVAL=1
export COFORGE_EVAL_ARMS="${COFORGE_EVAL_ARMS:-openviking}"
export COFORGE_EVAL_SAMPLE_INDEX="${COFORGE_EVAL_SAMPLE_INDEX:-0}"
export COFORGE_EVAL_SAMPLE_COUNT="${COFORGE_EVAL_SAMPLE_COUNT:-1}"
export COFORGE_EVAL_RESULT_DIR="${COFORGE_EVAL_RESULT_DIR:-$LSK_ROOT/benchmark/longmemeval-collab/result/lsk1-smoke}"
mkdir -p "$COFORGE_EVAL_RESULT_DIR"
cd "$LSK_ROOT"
exec bun benchmark/longmemeval-collab/src/run.ts
