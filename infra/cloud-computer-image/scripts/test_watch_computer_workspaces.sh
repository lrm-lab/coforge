#!/usr/bin/env bash
# Unit-test the needs_start JSON filter used by watch-computer-workspaces.sh.
set -euo pipefail

filter() {
  python3 - "$1" <<'PY'
import json, sys
try:
    data = json.loads(sys.argv[1])
except Exception:
    sys.exit(0)
ws = (data.get("workspaces") or {}).get("workspaces") or []
for item in ws:
    if not item.get("enabled"):
        continue
    health = item.get("health") or {}
    if health.get("status") == "parked":
        continue
    cloud = ((item.get("cloudConnection") or {}).get("state") or "")
    running = bool(item.get("running"))
    if running and cloud == "connected":
        continue
    if running and cloud == "connecting":
        continue
    wid = item.get("workspaceId")
    if isinstance(wid, str) and wid:
        print(wid)
PY
}

ok='{"workspaces":{"workspaces":[{"workspaceId":"a","enabled":true,"running":true,"cloudConnection":{"state":"connected"},"health":{"status":"ok"}}]}}'
down='{"workspaces":{"workspaces":[{"workspaceId":"b","enabled":true,"running":false,"cloudConnection":{"state":""},"health":{"status":"ok"}}]}}'
parked='{"workspaces":{"workspaces":[{"workspaceId":"c","enabled":true,"running":false,"cloudConnection":{"state":""},"health":{"status":"parked"}}]}}'
connecting='{"workspaces":{"workspaces":[{"workspaceId":"d","enabled":true,"running":true,"cloudConnection":{"state":"connecting"},"health":{"status":"ok"}}]}}'

[[ -z "$(filter "$ok")" ]]
[[ "$(filter "$down")" == "b" ]]
[[ -z "$(filter "$parked")" ]]
[[ -z "$(filter "$connecting")" ]]
echo "ok"
