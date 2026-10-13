#!/bin/bash
# mine-watch.sh — self-healing watchdog for MY eval campaigns (baseline line).
# Identifies MY processes via /proc/<pid>/environ (COFORGE_EVALUATION_ID), never
# by cmdline (the sibling lsk campaign runs identical cmdlines).
# Heals: sf2/sf3/sf4/sfcold1/sfcold2 shards, sb lanes 0-2, as-seq/as-int/as-iso/past shards.
SFM=/home/zhoujie22/river2_0/.worktrees/cursor-ov-cm-impl/benchmark/evolbench-collab/data/skillflow.jsonl
ASD=/home/zhoujie22/river2_0/evol_bench/AgentStream/data
PASTM=/home/zhoujie22/river2_0/evol_bench/PAST-Bench/data/past-notes-memory.jsonl
SFNOTE="Environment: this task runs in an official Docker container managed by the env server at http://127.0.0.1:8733. First bind it: curl -s -X POST http://127.0.0.1:8733/env -H 'content-type: application/json' -d '{\"task_id\": \"%TASK_ID%\", \"episode_id\": \"%EPISODE_ID%\"}'. Then run every command as: curl -s -X POST http://127.0.0.1:8733/execute -H 'content-type: application/json' -d '{\"episode_id\": \"%EPISODE_ID%\", \"command\": \"<cmd>\", \"timeout_sec\": 600}' and read produced files through the same endpoint. Work in /root inside the container; do not use your local shell."
SFE="COFORGE_EVAL_EPISODE_TIMEOUT_MS=2100000"
SFV="COFORGE_EVAL_VERIFY_SIDECAR=http://127.0.0.1:8733"

count_eval() {  # $1 = evaluation id
  local n=0 pid
  for pid in $(pgrep -f 'collab/src/run.ts' 2>/dev/null); do
    if tr '\0' '\n' < /proc/$pid/environ 2>/dev/null | grep -q "^COFORGE_EVALUATION_ID=$1$"; then n=$((n+1)); fi
  done
  echo $n
}

while true; do
  TS=$(date -u +%m-%d' '%H:%M:%S)
  # --- SkillFlow shards ---
  if [ "$(count_eval sf-full-collab-1)" -eq 0 ] && ! pgrep -f 'evol-shard.sh sf[234]' >/dev/null 2>&1 && ! pgrep -f 'evol-shard.sh sfcold' >/dev/null 2>&1; then
    echo "$TS relaunch 5 sf shards" >> /tmp/mine-watch.log
    setsid /tmp/evol-shard.sh sf2 $SFM sf-full-collab-1 warm,cold "sf_Embedded-Data-Repair,sf_Financial-Statement-Rolling,sf_HWPX-Document-Automation,sf_Healthcare-Cost-Benefit-Analysis,sf_Industry-Correlation-Analysis" - "$SFE" "$SFV" "COFORGE_EVAL_ENV_NOTE=$SFNOTE" >> /tmp/shard-sf2.log 2>&1 &
    setsid /tmp/evol-shard.sh sf3 $SFM sf-full-collab-1 warm,cold "sf_Inventory-&-Finance-Integration,sf_Medical-Data-Standardization,sf_OCR-Data-Extraction,sf_Operational-Recovery-Planning,sf_PPT-Formatting-Optimization" - "$SFE" "$SFV" "COFORGE_EVAL_ENV_NOTE=$SFNOTE" >> /tmp/shard-sf3.log 2>&1 &
    setsid /tmp/evol-shard.sh sf4 $SFM sf-full-collab-1 warm,cold "sf_Production-Capacity-Planning,sf_SEC-13F-Financial-Analysis,sf_Sales-Pivot-Analysis,sf_Supply-Chain-Replenishment,sf_Weighted-Risk-Assessment" - "$SFE" "$SFV" "COFORGE_EVAL_ENV_NOTE=$SFNOTE" >> /tmp/shard-sf4.log 2>&1 &
    setsid /tmp/evol-shard.sh sfcold1 $SFM sf-full-collab-1 cold - 2:0 "$SFE" "$SFV" "COFORGE_EVAL_ENV_NOTE=$SFNOTE" >> /tmp/shard-sfcold1.log 2>&1 &
    setsid /tmp/evol-shard.sh sfcold2 $SFM sf-full-collab-1 cold - 2:1 "$SFE" "$SFV" "COFORGE_EVAL_ENV_NOTE=$SFNOTE" >> /tmp/shard-sfcold2.log 2>&1 &
  fi
  # --- AgentStream ×3 + PAST ---
  declare -A SPEC=(
    [as-seq-collab-1]="/tmp/evol-shard.sh as-seq1 $ASD/agentstream-sequential-seed1.jsonl as-seq-collab-1 warm,cold - >> /tmp/shard-as-seq1.log 2>&1 &"
    [as-int-collab-1]="/tmp/evol-shard.sh as-int1 $ASD/agentstream-interleaved-seed1.jsonl as-int-collab-1 warm,cold - >> /tmp/shard-as-int1.log 2>&1 &"
    [as-iso-collab-1]="/tmp/evol-shard.sh as-iso1 $ASD/agentstream-isolated-seed1.jsonl as-iso-collab-1 warm,cold - >> /tmp/shard-as-iso1.log 2>&1 &"
    [past-collab-1]="/tmp/evol-shard.sh past1 $PASTM past-collab-1 warm,cold - >> /tmp/shard-past1.log 2>&1 &"
  )
  declare -A WRAP=([as-seq-collab-1]='evol-shard.sh as-seq1' [as-int-collab-1]='evol-shard.sh as-int1' [as-iso-collab-1]='evol-shard.sh as-iso1' [past-collab-1]='evol-shard.sh past1')
  for ev in "${!SPEC[@]}"; do
    if [ "$(count_eval $ev)" -eq 0 ] && ! pgrep -f "${WRAP[$ev]}" >/dev/null 2>&1; then
      echo "$TS relaunch $ev" >> /tmp/mine-watch.log
      eval "setsid ${SPEC[$ev]}"
    fi
  done
  # --- sb lanes ---
  if [ "$(pgrep -fc '/tmp/sb-lane.sh [012]' 2>/dev/null || echo 0)" -eq 0 ]; then
    echo "$TS relaunch sb lanes 0-2" >> /tmp/mine-watch.log
    for l in 0 1 2; do setsid /tmp/sb-lane.sh $l 4 >> /tmp/sb-lane$l.log 2>&1 & done
  fi
  echo "$TS watch: sf=$(count_eval sf-full-collab-1) seq=$(count_eval as-seq-collab-1) int=$(count_eval as-int-collab-1) iso=$(count_eval as-iso-collab-1) past=$(count_eval past-collab-1) sb=$(pgrep -fc '/tmp/sb-lane.sh [012]' 2>/dev/null || echo 0)" >> /tmp/mine-watch.log
  sleep 300
done
