#!/usr/bin/env bash
# One OS identity and one directory per Workspace bound to this Computer, written
# before the Daemon spawns any Agent. Workspaces share a container, so a distinct
# uid per Workspace is what makes the shared volume a boundary; the Daemon reads
# the same profile and drops to it. Idempotent, and COFORGE_WORKSPACE_IDENTITIES=0
# opts out.
set -euo pipefail

log() { echo "[workspace-identities] $*"; }

[[ "${COFORGE_WORKSPACE_IDENTITIES:-1}" == "0" ]] && { log "disabled by env"; exit 0; }
[[ "$(id -u)" == "0" ]] || { log "not root, nothing to provision"; exit 0; }

VOLUME_ROOT="${COFORGE_WORKSPACE_VOLUME_ROOT:-/srv/coforge}"
WS_ROOT="${VOLUME_ROOT}/ws"
SHARED="${VOLUME_ROOT}/shared"
PROFILE="${WS_ROOT}/workspace-identities.json"
BINDINGS="${COFORGE_BINDINGS_FILE:-/root/.coforge/daemon/bindings.json}"
UID_BASE=20100
UID_MAX=20250

mkdir -p "${WS_ROOT}"
chmod 711 "${WS_ROOT}"

if [[ ! -f "${BINDINGS}" ]]; then
  log "no bindings file at ${BINDINGS}; nothing to provision"
  exit 0
fi

workspace_ids="$(node -e '
const fs = require("node:fs");
const entries = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const ids = [...new Set(entries.filter((e) => e.enabled !== false).map((e) => e.workspaceId))].sort();
process.stdout.write(ids.join("\n"));
' "${BINDINGS}")"

[[ -n "${workspace_ids}" ]] || { log "no enabled bindings"; exit 0; }

node - "$PROFILE" "$UID_BASE" "$UID_MAX" $workspace_ids <<'NODE'
const fs = require("node:fs");
const [profilePath, base, max, ...ids] = process.argv.slice(2);
let profile = {};
try { profile = JSON.parse(fs.readFileSync(profilePath, "utf8")); } catch {}
const used = new Set(Object.values(profile).map((entry) => entry.uid));
let next = Number(base) + 1;
for (const id of ids) {
  if (profile[id]) continue;
  while (used.has(next) && next < Number(max)) next += 1;
  if (next >= Number(max)) throw new Error("workspace uid range exhausted");
  profile[id] = { uid: next, gid: next };
  used.add(next);
  next += 1;
}
const ordered = Object.fromEntries(Object.keys(profile).sort().map((key) => [key, profile[key]]));
fs.writeFileSync(profilePath, `${JSON.stringify(ordered, null, 2)}\n`, { mode: 0o644 });
NODE

while IFS= read -r wsid; do
  [[ -n "${wsid}" ]] || continue
  uid="$(node -e 'process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"))[process.argv[2]].uid))' "${PROFILE}" "${wsid}")"
  gid="${uid}"
  user="coforge-ws-${wsid:0:8}"

  if ! getent passwd "${uid}" >/dev/null; then
    if ! getent group "${gid}" >/dev/null; then
      groupadd --gid "${gid}" "coforge-gid-${gid}"
    fi
    useradd --uid "${uid}" --gid "${gid}" --no-create-home \
      --home-dir "${WS_ROOT}/${wsid}" --shell /usr/sbin/nologin \
      --comment "CoForge workspace agent identity" "${user}"
    log "created ${user} (uid ${uid})"
  fi

  mkdir -p "${WS_ROOT}/${wsid}"/{work,home,cache}
  chown -R "${uid}:${gid}" "${WS_ROOT}/${wsid}"
  chmod 700 "${WS_ROOT}/${wsid}" "${WS_ROOT}/${wsid}"/{work,home,cache}
done <<< "${workspace_ids}"

mkdir -p "${SHARED}"
chown 0:0 "${SHARED}"
chmod 755 "${SHARED}"
log "profile ${PROFILE} ready for $(wc -l <<< "${workspace_ids}") workspace(s)"
