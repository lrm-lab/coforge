#!/bin/bash
cd /home/zhoujie22/river2_0/.worktrees/cursor-ov-cm-impl/benchmark/evolbench-collab/result
LCBPY=/home/zhoujie22/river2_0/evol_bench/EvoAgentBench/code/vendor/lcb-venv/bin/python
BRIDGE=/tmp/evo-grading-0909/graders/lcb_grade.py
for M in int iso; do
  echo "=== grading $M $(date -u +%H:%M:%S)"
  PYTHONPATH=/tmp/evo-grading-0909 python3 /home/zhoujie22/river2_0/evol_bench/AgentStream/code/agentstream_grading.py \
    --attempts grade-as-$M/attempts.jsonl \
    --manifest /home/zhoujie22/river2_0/evol_bench/AgentStream/data/agentstream-$([ $M = int ] && echo interleaved || echo isolated)-seed1.jsonl \
    --lcb-python "$LCBPY" --bridge "$BRIDGE" 2>&1 | tail -20
  echo "=== exit $? $(date -u +%H:%M:%S)"
done
