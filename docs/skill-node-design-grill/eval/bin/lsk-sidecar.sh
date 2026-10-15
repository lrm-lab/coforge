#!/bin/bash
# Isolated SLB/SF env sidecars on 8734/8735 (never 8732/8733).
# usage: lsk-sidecar.sh slb|sf
set -euo pipefail
PROFILE=${1:?usage: lsk-sidecar.sh slb|sf}
EVAL=/home/zhoujie22/river2_0/skill-node-design-grill/eval
SERVER=/home/zhoujie22/river2_0/evol_bench/SkillsBench/code/skillsbench_env_server.py
PROXY="${LSK_SIDECAR_PROXY:-http://172.17.0.1:7893}"
case "$PROFILE" in
  slb)
    PORT=8734
    TASKS=/home/zhoujie22/river2_0/evol_bench/SkillLearnBench/code/vendor/skilllearnbench-official
    PROF=skilllearnbench
    LOG=$EVAL/logs/sidecar-slb-8734.log
    cd /home/zhoujie22/river2_0/evol_bench/SkillLearnBench
    ;;
  sf)
    PORT=8735
    TASKS=/home/zhoujie22/river2_0/evol_bench/SkillFlow/data/SkillFlow-Task/test_tasks
    PROF=skillflow
    LOG=$EVAL/logs/sidecar-sf-8735.log
    cd /home/zhoujie22/river2_0/evol_bench/SkillFlow
    ;;
  *)
    echo "usage: lsk-sidecar.sh slb|sf" >&2
    exit 2
    ;;
esac
mkdir -p "$(dirname "$LOG")"
if ss -lnt | grep -q ":$PORT "; then
  echo "port $PORT already listening"
  exit 0
fi
export PYTHONUNBUFFERED=1
LIFECYCLE="${LOG%.log}-lifecycle.jsonl"
exec python3 "$SERVER" --tasks-root "$TASKS" --profile "$PROF" --port "$PORT" --log "$LIFECYCLE" --exec-proxy "$PROXY"
