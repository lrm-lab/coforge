#!/usr/bin/env bash
# Host-side smoke test for sync-pi-skills.sh (no Docker required).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SYNC="${ROOT}/scripts/sync-pi-skills.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

[[ -x "${SYNC}" ]] || chmod +x "${SYNC}"

WORK="${TMP}/workspace"
AGENT="${TMP}/agent"
TEMPLATE="${TMP}/template"
export WORKSPACE="${WORK}"
export PI_AGENT_DIR="${AGENT}"
export PI_SKILLS_TEMPLATE="${TEMPLATE}"

mkdir -p "${TEMPLATE}/browser-login" "${TEMPLATE}/cloud-computer-overview"
echo 'name: browser-login' >"${TEMPLATE}/browser-login/SKILL.md"
echo 'official' >"${TEMPLATE}/browser-login/marker.txt"
echo 'name: cloud-computer-overview' >"${TEMPLATE}/cloud-computer-overview/SKILL.md"

# Seed agent as a fresh image would.
mkdir -p "${AGENT}/skills"
cp -a "${TEMPLATE}/browser-login" "${AGENT}/skills/browser-login"
cp -a "${TEMPLATE}/cloud-computer-overview" "${AGENT}/skills/cloud-computer-overview"

# User skill only on the persistent volume.
mkdir -p "${WORK}/skills/hello-skill/scripts"
cat >"${WORK}/skills/hello-skill/SKILL.md" <<'EOF'
---
name: hello-skill
description: Minimal persistent skill for sync tests.
---
Say hello from a workspace-backed skill.
EOF
echo 'echo hello' >"${WORK}/skills/hello-skill/scripts/x.sh"
chmod +x "${WORK}/skills/hello-skill/scripts/x.sh"

# User override of an official skill.
mkdir -p "${WORK}/skills/browser-login"
echo 'name: browser-login' >"${WORK}/skills/browser-login/SKILL.md"
echo 'user-override' >"${WORK}/skills/browser-login/marker.txt"

"${SYNC}"

[[ -f "${AGENT}/skills/hello-skill/SKILL.md" ]] || { echo "FAIL: hello-skill missing"; exit 1; }
[[ -x "${AGENT}/skills/hello-skill/scripts/x.sh" ]] || { echo "FAIL: script not copied"; exit 1; }
[[ ! -L "${AGENT}/skills/hello-skill" ]] || { echo "FAIL: hello-skill is a symlink"; exit 1; }
grep -q 'user-override' "${AGENT}/skills/browser-login/marker.txt" || { echo "FAIL: override not applied"; exit 1; }
[[ -f "${AGENT}/skills/cloud-computer-overview/SKILL.md" ]] || { echo "FAIL: image skill missing"; exit 1; }
# Official copy should have been backed up under workspace/.bak
bak_count="$(find "${WORK}/skills/.bak" -mindepth 1 -maxdepth 1 -type d -name 'browser-login-*' 2>/dev/null | wc -l)"
[[ "${bak_count}" -ge 1 ]] || { echo "FAIL: expected browser-login backup"; exit 1; }

# Simulate container restart: wipe agent skills back to image-only.
rm -rf "${AGENT}/skills"
mkdir -p "${AGENT}/skills"
cp -a "${TEMPLATE}/browser-login" "${AGENT}/skills/browser-login"
cp -a "${TEMPLATE}/cloud-computer-overview" "${AGENT}/skills/cloud-computer-overview"

"${SYNC}"
grep -q 'user-override' "${AGENT}/skills/browser-login/marker.txt" || { echo "FAIL: override lost after restart"; exit 1; }
[[ -f "${AGENT}/skills/hello-skill/SKILL.md" ]] || { echo "FAIL: hello-skill lost after restart"; exit 1; }

# Second sync must be idempotent (no duplicate skill dirs).
before="$(find "${AGENT}/skills" -mindepth 1 -maxdepth 1 | LC_ALL=C sort | tr '\n' '|')"
"${SYNC}"
after="$(find "${AGENT}/skills" -mindepth 1 -maxdepth 1 | LC_ALL=C sort | tr '\n' '|')"
[[ "${before}" == "${after}" ]] || { echo "FAIL: second sync changed skill set"; exit 1; }

# Delete from workspace → agent copy must go away (and not resurrect from nowhere).
rm -rf "${WORK}/skills/hello-skill"
"${SYNC}"
[[ ! -e "${AGENT}/skills/hello-skill" ]] || { echo "FAIL: deleted skill resurrected in agent"; exit 1; }
[[ ! -e "${WORK}/skills/hello-skill" ]] || { echo "FAIL: deleted skill resurrected in workspace"; exit 1; }

# Agent-only custom skill (never in workspace before) should be promoted once.
mkdir -p "${AGENT}/skills/agent-only"
echo 'name: agent-only' >"${AGENT}/skills/agent-only/SKILL.md"
echo 'from-agent' >"${AGENT}/skills/agent-only/marker.txt"
"${SYNC}"
[[ -f "${WORK}/skills/agent-only/SKILL.md" ]] || { echo "FAIL: agent-only not promoted"; exit 1; }
# Wipe agent (restart) and ensure promoted copy restores.
rm -rf "${AGENT}/skills/agent-only"
"${SYNC}"
[[ -f "${AGENT}/skills/agent-only/marker.txt" ]] || { echo "FAIL: promoted skill not restored"; exit 1; }
grep -q 'from-agent' "${AGENT}/skills/agent-only/marker.txt" || { echo "FAIL: promoted content wrong"; exit 1; }

# Crash mid-sync leftover .tmp must be cleaned.
mkdir -p "${AGENT}/skills/broken.tmp"
echo junk >"${AGENT}/skills/broken.tmp/SKILL.md"
"${SYNC}"
[[ ! -e "${AGENT}/skills/broken.tmp" ]] || { echo "FAIL: tmp leftover not cleaned"; exit 1; }

# Softlink workaround replaced by real tree.
mkdir -p "${WORK}/skills/link-skill"
echo 'name: link-skill' >"${WORK}/skills/link-skill/SKILL.md"
rm -rf "${AGENT}/skills/link-skill"
ln -s "${WORK}/skills/link-skill" "${AGENT}/skills/link-skill"
"${SYNC}"
[[ ! -L "${AGENT}/skills/link-skill" ]] || { echo "FAIL: softlink not replaced"; exit 1; }
[[ -f "${AGENT}/skills/link-skill/SKILL.md" ]] || { echo "FAIL: link-skill missing after replace"; exit 1; }

# Entrypoint wires sync after persist.
grep -q 'sync-pi-skills.sh' "${ROOT}/scripts/entrypoint-foreground.sh" \
  || { echo "FAIL: entrypoint missing sync hook"; exit 1; }

echo "OK sync-pi-skills smoke"
