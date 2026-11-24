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

# Directories the dropped child has to walk through, created by the launcher as 0700.
# Traversal only (`o+x`): the daemon state stays unlistable for an Agent, but the uid that
# owns a state directory can reach it without the spawn-time repair having to fix it again.
for shared_dir in "${VOLUME_ROOT}/daemon" "${VOLUME_ROOT}/daemon/workspaces" \
  "${VOLUME_ROOT}/daemon/logs" "${VOLUME_ROOT}/computer" \
  "${VOLUME_ROOT}/computer/install" "${VOLUME_ROOT}/computer/install/versions"; do
  [[ -d "${shared_dir}" ]] || continue
  chmod o+x "${shared_dir}"
done
for version_dir in "${VOLUME_ROOT}"/computer/install/versions/*/; do
  [[ -d "${version_dir}" ]] && chmod o+x "${version_dir}"
done

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

  # The daemon child and the Agents it spawns also own their own state: the socket,
  # the instance record and the session store must be writable by that uid, and
  # unreadable by the other Workspaces on this Computer.
  state_dir="${VOLUME_ROOT}/daemon/workspaces/$(node -e 'process.stdout.write(Buffer.from(process.argv[1]).toString("base64url"))' "${wsid}")"
  agent_dir="${VOLUME_ROOT}/agent-workspaces/${wsid}"
  for owned in "${state_dir}" "${agent_dir}"; do
    [[ -d "${owned}" ]] || continue
    chown -R "${uid}:${gid}" "${owned}"
    chmod 700 "${owned}"
  done
done <<< "${workspace_ids}"

mkdir -p "${SHARED}"
chown 0:0 "${SHARED}"
chmod 755 "${SHARED}"

# After the lines above, not before: they reset `${SHARED}` to `0755 root:root`, which would undo
# the group below. The shared tree is the one place two Workspace Agents can meet; every
# per-Workspace directory stays 0700.
SHARED_GID="${COFORGE_WORKSPACE_SHARED_GID:-20100}"
if getent group "${SHARED_GID}" >/dev/null || groupadd --gid "${SHARED_GID}" coforge-workspace; then
  node -e 'process.stdout.write(JSON.stringify({ gid: Number(process.argv[1]) }) + "\n")' \
    "${SHARED_GID}" > "${WS_ROOT}/workspace-shared-group.json"
  chmod 644 "${WS_ROOT}/workspace-shared-group.json"
  for shared_tree in /workspace "${SHARED}"; do
    [[ -d "${shared_tree}" ]] || continue
    # Existing files are `root:root 0644`: without this an Agent could create new files in the
    # shared tree but not edit the ones already there, which reads as "my files went read-only".
    #
    # Resolve the tree once, then recurse *without* following links: `/workspace` is a symlink, and
    # GNU `chgrp -R`/`find` default to `-P`, so recursing on the link silently did nothing while the
    # `chmod` below (which follows it) landed - the top looked right and everything inside stayed
    # `root:root 0700`. Recursing with `-L` instead would be worse: users keep their own symlinks
    # under /workspace, and following them would widen the boundary onto /root and the daemon state.
    #
    # `g+rwxs` on directories, because a 0700 directory that gains only write and setgid is still
    # not enterable; files get `g+rw` only, so nothing becomes executable that was not.
    #
    # The marker is versioned and written only when every step succeeded: the volume already holds
    # `.shared-group-20100` from the image that did not actually fix the tree, so a same-named marker
    # would make this repair never run again on existing volumes.
    # One marker per tree, never one for both: `/workspace` and `${SHARED}` are different
    # directories, and a shared marker let a successful `${SHARED}` hide a failed `/workspace` -
    # which is exactly the state this change fixes, so it must not be able to come back silently.
    marker_name="workspace"
    [[ "${shared_tree}" == "${SHARED}" ]] && marker_name="shared"
    marker="${VOLUME_ROOT}/.shared-group-${SHARED_GID}-v2-${marker_name}"
    if [[ ! -f "${marker}" ]]; then
      resolved="$(readlink -f "${shared_tree}" 2>/dev/null || true)"
      [[ -n "${resolved}" && -d "${resolved}" ]] || resolved="${shared_tree}"
      repaired=1
      failed_step=""
      chgrp -R "${SHARED_GID}" "${resolved}" 2>/dev/null || { repaired=0; failed_step="chgrp -R"; }
      find "${resolved}" -type d -exec chmod g+rwxs {} + 2>/dev/null || { repaired=0; failed_step="${failed_step:-chmod dirs}"; }
      find "${resolved}" -type f -perm -u+w -exec chmod g+rw {} + 2>/dev/null || { repaired=0; failed_step="${failed_step:-chmod files}"; }
      if [[ "${repaired}" -eq 1 ]]; then
        : > "${marker}"
      else
        # Say it: a silent failure here means every start re-walks the whole shared tree (minutes on
        # a large one) and the only symptom a user sees is "this computer boots slower".
        log "shared tree ${shared_tree}: ${failed_step} failed; not marked done, retried next start"
      fi
    fi
    chgrp "${SHARED_GID}" "${shared_tree}" 2>/dev/null || true
    chmod 2775 "${shared_tree}"
  done
  log "shared group ${SHARED_GID}: /workspace and ${SHARED} are 2775"
else
  log "shared group ${SHARED_GID} unavailable; Agents keep their own gid"
fi

log "profile ${PROFILE} ready for $(wc -l <<< "${workspace_ids}") workspace(s)"
