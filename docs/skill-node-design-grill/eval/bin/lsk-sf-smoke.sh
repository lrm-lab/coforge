#!/bin/bash
# SkillFlow 2-episode warm smoke on isolated learned-skill stack.
# Starts sidecar on 8735 if needed. Does not touch 8733.
set -euo pipefail
EVAL=/home/zhoujie22/river2_0/skill-node-design-grill/eval
# shellcheck disable=SC1091
source "$EVAL/bin/lsk-common.sh"
if ! ss -lnt | grep -q ':8735 '; then
  setsid "$EVAL/bin/lsk-sidecar.sh" sf >> "$EVAL/logs/sidecar-sf-8735.log" 2>&1 &
  for _ in $(seq 1 30); do
    ss -lnt | grep -q ':8735 ' && break
    sleep 1
  done
fi
export COFORGE_EVOLBENCH_COLLAB_EVAL=1
export COFORGE_EVAL_MANIFEST="$EVAL/manifests/sf-lsk-smoke.jsonl"
export COFORGE_EVAL_ARMS=warm
export COFORGE_EVALUATION_ID="${COFORGE_EVALUATION_ID:-sf-lsk1-smoke}"
export COFORGE_EVAL_RESULT_DIR="$LSK_ROOT/benchmark/evolbench-collab/result/lsk1-smoke"
export COFORGE_EVAL_RESUME=0
export COFORGE_EVAL_EPISODE_TIMEOUT_MS=2100000
export COFORGE_EVAL_VERIFY_SIDECAR=http://127.0.0.1:8735
export COFORGE_EVAL_ENV_NOTE='Environment: this task runs in an official Docker container managed by the env server at http://127.0.0.1:8735. First bind it: curl -s -X POST http://127.0.0.1:8735/env -H "content-type: application/json" -d "{\"task_id\": \"%TASK_ID%\", \"episode_id\": \"%EPISODE_ID%\"}" (the first bind may take a few minutes while the Docker image builds). Then run every command of the task as: curl -s -X POST http://127.0.0.1:8735/execute -H "content-type: application/json" -d "{\"episode_id\": \"%EPISODE_ID%\", \"command\": \"<your shell command>\", \"timeout_sec\": 600}" and read the files you produce through the same endpoint. Execute the entire task through this endpoint; do not use your local shell for task work. Work in /root inside the container.'
mkdir -p "$COFORGE_EVAL_RESULT_DIR"
cd "$LSK_ROOT"
exec bun benchmark/evolbench-collab/src/run.ts
