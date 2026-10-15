#!/bin/bash
# SkillFlow full warm+cold on isolated stack. Sidecar 8735.
set -euo pipefail
EVAL=/home/zhoujie22/river2_0/skill-node-design-grill/eval
MAN=/home/zhoujie22/river2_0/.worktrees/cursor-lsk-eval/benchmark/evolbench-collab/data/skillflow.jsonl
NOTE='Environment: this task runs in an official Docker container managed by the env server at http://127.0.0.1:8735. First bind it: curl -s -X POST http://127.0.0.1:8735/env -H "content-type: application/json" -d "{\"task_id\": \"%TASK_ID%\", \"episode_id\": \"%EPISODE_ID%\"}" (the first bind may take a few minutes while the Docker image builds). Then run every command as: curl -s -X POST http://127.0.0.1:8735/execute -H "content-type: application/json" -d "{\"episode_id\": \"%EPISODE_ID%\", \"command\": \"<cmd>\", \"timeout_sec\": 600}" and read produced files through the same endpoint. Work in /root inside the container; do not use your local shell.'
if ! ss -lnt | grep -q ':8735 '; then
  setsid "$EVAL/bin/lsk-sidecar.sh" sf >> "$EVAL/logs/sidecar-sf-8735.log" 2>&1 &
  sleep 2
fi
F1="sf_Compensation-Scenario-Modeling,sf_Cross-Format-Data-Reconciliation,sf_DMAIC-Quality-Analysis,sf_Distribution-Center-Auditing,sf_Document-Fraud-Detection"
F2="sf_Embedded-Data-Repair,sf_Financial-Statement-Rolling,sf_HWPX-Document-Automation,sf_Healthcare-Cost-Benefit-Analysis,sf_Industry-Correlation-Analysis"
F3="sf_Inventory-&-Finance-Integration,sf_Medical-Data-Standardization,sf_OCR-Data-Extraction,sf_Operational-Recovery-Planning,sf_PPT-Formatting-Optimization"
F4="sf_Production-Capacity-Planning,sf_SEC-13F-Financial-Analysis,sf_Sales-Pivot-Analysis,sf_Supply-Chain-Replenishment,sf_Weighted-Risk-Assessment"
i=1
for FAM in "$F1" "$F2" "$F3" "$F4"; do
  setsid "$EVAL/bin/lsk-evol-shard.sh" "sf$i" "$MAN" sf-lsk1 warm,cold "$FAM" - \
    "COFORGE_EVAL_EPISODE_TIMEOUT_MS=2100000" \
    "COFORGE_EVAL_VERIFY_SIDECAR=http://127.0.0.1:8735" \
    "COFORGE_EVAL_ENV_NOTE=$NOTE" &
  i=$((i+1))
done
echo "started sf-lsk1 shards 1-4"
