#!/bin/bash
# SkillLearnBench protocol-v1 smoke: 1 large + 1 small family.
# warm-loop = train + first 2 test per family (6). cold = the 4 test episodes.
# Sidecar 8734. Does not touch 8732. Does not rerun evo-lsk1.
set -euo pipefail
EVAL=/home/zhoujie22/river2_0/skill-node-design-grill/eval
# shellcheck disable=SC1091
source "$EVAL/bin/lsk-common.sh"
if ! ss -lnt | grep -q ':8734 '; then
  setsid "$EVAL/bin/lsk-sidecar.sh" slb >> "$EVAL/logs/sidecar-slb-8734.log" 2>&1 &
  for _ in $(seq 1 30); do
    ss -lnt | grep -q ':8734 ' && break
    sleep 1
  done
fi
export COFORGE_EVOLBENCH_COLLAB_EVAL=1
export COFORGE_EVAL_MANIFEST="$EVAL/manifests/slb-lsk-protocol-smoke.jsonl"
export COFORGE_EVAL_ARMS="${COFORGE_EVAL_ARMS:-warm,cold}"
export COFORGE_EVALUATION_ID="${COFORGE_EVALUATION_ID:-slb-lsk1-smoke}"
export COFORGE_EVAL_RESULT_DIR="$LSK_ROOT/benchmark/evolbench-collab/result/lsk1-smoke"
export COFORGE_EVAL_RESUME="${COFORGE_EVAL_RESUME:-0}"
export COFORGE_EVAL_EPISODE_TIMEOUT_MS=1500000
export COFORGE_EVAL_ABORT_QUIET_MS=0
export COFORGE_EVAL_LOOP_OFFER=1
export COFORGE_EVAL_VERIFY_SIDECAR=http://127.0.0.1:8734
export COFORGE_EVAL_ENV_NOTE='Environment: the harness already bound this episode at http://127.0.0.1:8734 (POST /env for %TASK_ID% / %EPISODE_ID% is done). Execute every command as: curl -s -X POST http://127.0.0.1:8734/execute -H "content-type: application/json" -d "{\"episode_id\": \"%EPISODE_ID%\", \"command\": \"<your shell command>\", \"timeout_sec\": 600}". Do not use your local shell for task work. When finished, post a short completion listing each /root/ path you wrote.'
mkdir -p "$COFORGE_EVAL_RESULT_DIR" "$EVAL/logs"
cd "$LSK_ROOT"
exec bun benchmark/evolbench-collab/src/run.ts
