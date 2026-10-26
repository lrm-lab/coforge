#!/usr/bin/env bash
# End-to-end test of the Rust coforge-installer and the Computer's upgrade path on Linux.
#
# Runs INSIDE the OrbStack VM `coforge-linux` (Ubuntu 24.04 arm64), never on macOS: it installs,
# starts, stops and upgrades CoForge for the VM user, and it deletes ~/.coforge and the
# coforge-daemon user unit first. Start it from any checkout that the VM mounts from the Mac; the
# script derives its checkout from its own location:
#
#   orb -m coforge-linux bash -lc '<checkout>/scripts/e2e/installer-linux.sh'
#
# Prerequisites (VM): systemd user manager running with lingering enabled, mise at
# ~/.local/bin/mise, build-essential and musl-tools, python3, git, and the checkout mounted at
# its Mac path. The Rust and Bun toolchains come from mise (crates/installer/mise.toml).
#
# What it proves (scenarios in summary.md):
#   1  fresh install of a Computer release from a local directory
#   2  the Computer's supervisor runs as the coforge-daemon.service user unit
#   3  upgrade with a running supervisor, deadProcessIdentities, and same-id replay
#   4  upgrade to a broken release rolls back (UPGRADE_ROLLED_BACK) and restores the supervisor
#      and a downgrade without --allow-downgrade is refused (UPGRADE_DOWNGRADE_REFUSED) with
#      nothing changed
#   5  SIGKILL during activation, a refused new upgrade (exit 3), and `coforge-installer recover`
#   6  `coforge-computer upgrade` obtains the installer and the release from a loopback
#      http://127.0.0.1 feed compiled into both binaries
#
# Build inputs are built fresh in the VM from a snapshot of this checkout (the working tree,
# uncommitted files included). Nothing under the Mac's target/ or node_modules/ is used.
#
# Where it writes: <checkout>/.amp/e2e/installer-linux/<UTC timestamp>/
#   summary.md        scenario -> expected -> observed -> PASS/FAIL table
#   summary.tsv       the same rows, tab separated
#   environment.txt   commit, dirty file count, tool versions
#   steps/<id>/       command.txt, stdout, stderr, exit_code, and evidence snapshots
#                     (receipts, active.json, journal, systemd status, processes, lifecycle)
#   feed-server.log   the loopback feed's request log for scenario 6
#
# Exit status: 0 when every row passes, 1 when any row fails, 2 when the guard refuses to run.

set -uo pipefail

if [[ "$(uname -s)" != Linux || "$(hostname)" != coforge-linux ]]; then
  echo "installer-linux.sh: refused: this E2E runs only inside the VM coforge-linux" >&2
  exit 2
fi

REPO=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$REPO/.amp/e2e/installer-linux/$STAMP"
WORK="$HOME/coforge-installer-e2e"
SRC="$WORK/src"
BIN="$WORK/bin"
PKG="$WORK/pkg"
FEED="$WORK/feed"
LOOP_PORT=18765
LOOP_FEED="http://127.0.0.1:$LOOP_PORT"
WEB_URL=http://127.0.0.1:8789
TARGET_DIR="$HOME/target-linux"
export CARGO_TARGET_DIR="$TARGET_DIR"
XDG_RUNTIME_DIR="/run/user/$(id -u)"
export XDG_RUNTIME_DIR
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
export PATH="$HOME/.local/bin:$PATH"
unset COFORGE_RELEASE_FEED_URL

ROOT="$HOME/.coforge/computer/install"
UNIT="$HOME/.config/systemd/user/coforge-daemon.service"
INSTALLER="$BIN/coforge-installer"
RESULTS="$OUT/summary.tsv"
FAILURES=0
FEED_PID=""

mkdir -p "$OUT/steps"
: >"$RESULTS"

# ---------------------------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------------------------

log() { printf '==> %s\n' "$*"; }

# record <scenario> <expected> <observed> <0|1 pass> <evidence path>
record() {
  local status=FAIL
  [[ "$4" == 0 ]] && status=PASS
  [[ "$4" == 0 ]] || FAILURES=$((FAILURES + 1))
  printf '%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$status" "$5" | tr '\r' ' ' >>"$RESULTS"
  log "[$status] $1 $2"
}

# clean <text>: one line, no tabs or pipes, for the tables.
clean() { tr '\n\t|' '   ' | sed 's/  */ /g' | cut -c1-400; }

# step <id> <command...>: runs one command, keeps its stdout, stderr and exit code under steps/<id>.
# The exit code is left in STEP_RC; the command line is recorded first.
step() {
  local id=$1
  shift
  local dir="$OUT/steps/$id"
  mkdir -p "$dir"
  printf '%s\n' "$*" >"$dir/command.txt"
  timeout 420 "$@" >"$dir/stdout" 2>"$dir/stderr"
  STEP_RC=$?
  printf '%s\n' "$STEP_RC" >"$dir/exit_code"
}

# json_eval <file> <python expression over d>: prints the value, or an error marker.
json_eval() {
  python3 -c 'import json,sys
try:
    d = json.load(open(sys.argv[1]))
    print(eval(sys.argv[2]))
except Exception as error:
    print("ERROR:", error)' "$1" "$2"
}

newest_result() {
  find "$ROOT/upgrade-results" -maxdepth 1 -name '*.result.json' -printf '%T@ %p\n' 2>/dev/null |
    sort -rn | head -1 | cut -d' ' -f2-
}

uuid() { cat /proc/sys/kernel/random/uuid; }

# count PATTERN FILE: matching lines, 0 when there are none or the file is missing. `grep -c` prints
# 0 itself on no match, so a `|| echo 0` fallback would yield two lines.
count() {
  local n
  n=$(grep -c "$1" "$2" 2>/dev/null)
  echo "${n:-0}"
}

# main_pid: the systemd main process of the supervisor unit, 0 when none.
main_pid() { systemctl --user show -p MainPID --value coforge-daemon.service 2>/dev/null || echo 0; }

# lifecycle_field <expression over d>: reads `__lifecycle status` from the installed Computer.
lifecycle_json() {
  if [[ -x "$ROOT/active/coforge-computer" ]]; then
    timeout 20 "$ROOT/active/coforge-computer" __lifecycle status 2>/dev/null
  else
    echo '{}'
  fi
}

# snapshot <dir> : the evidence set the task asks for, before and after each scenario.
snapshot() {
  local dir=$1
  mkdir -p "$dir/receipts"
  {
    echo "date: $(date -u +%FT%TZ)"
    echo "active -> $(readlink "$ROOT/active" 2>/dev/null || echo missing)"
    echo "shim -> $(readlink "$HOME/.local/bin/coforge-computer" 2>/dev/null || echo missing)"
    echo "journal (installer-transaction.json): $([[ -e "$ROOT/installer-transaction.json" ]] && echo present || echo absent)"
    echo "unit file: $([[ -f "$UNIT" ]] && echo present || echo absent)"
    echo "MainPID: $(main_pid)"
  } >"$dir/state.txt"
  if [[ -f "$ROOT/active.json" ]]; then cp "$ROOT/active.json" "$dir/active.json"; fi
  if [[ -f "$ROOT/installer-transaction.json" ]]; then cp "$ROOT/installer-transaction.json" "$dir/journal.json"; fi
  if [[ -d "$ROOT/upgrade-results" ]]; then cp "$ROOT"/upgrade-results/* "$dir/receipts/" 2>/dev/null || true; fi
  systemctl --user status coforge-daemon.service --no-pager >"$dir/systemd-status.txt" 2>&1 || true
  pgrep -a -f "^$HOME/.coforge/computer/install/" >"$dir/processes.txt" 2>/dev/null || echo "none" >"$dir/processes.txt"
  lifecycle_json >"$dir/lifecycle.json"
}

# wait_for_pids_gone <pid...>: true once none of the pids is alive.
pid_alive() { kill -0 "$1" 2>/dev/null; }

# reset_vm_state: VM only. Stops the supervisor and removes everything this E2E installs.
reset_vm_state() {
  log "Resetting VM CoForge state (VM user only)"
  systemctl --user stop coforge-daemon.service >/dev/null 2>&1 || true
  systemctl --user disable coforge-daemon.service >/dev/null 2>&1 || true
  pkill -f "^$HOME/.coforge/computer/install/" >/dev/null 2>&1 || true
  for _ in $(seq 1 50); do
    pgrep -f "^$HOME/.coforge/computer/install/" >/dev/null 2>&1 || break
    sleep 0.2
  done
  pkill -9 -f "^$HOME/.coforge/computer/install/" >/dev/null 2>&1 || true
  rm -f "$UNIT" "$HOME/.config/systemd/user/default.target.wants/coforge-daemon.service"
  rm -f "$HOME/.local/bin/coforge-computer"
  rm -rf "$HOME/.coforge"
  systemctl --user daemon-reload >/dev/null 2>&1 || true
  systemctl --user reset-failed coforge-daemon.service >/dev/null 2>&1 || true
}


# ---------------------------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------------------------

COMMIT=$(git -C "$REPO" rev-parse HEAD)
DIRTY=$(git -C "$REPO" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
{
  echo "commit: $COMMIT"
  echo "uncommitted paths in the checkout: $DIRTY"
  echo "vm: $(uname -a)"
  echo "os: $(grep '^PRETTY_NAME=' /etc/os-release | cut -d= -f2- | tr -d '"')"
  echo "mise: $(mise --version 2>/dev/null)"
  echo "python3: $(python3 --version 2>&1)"
} >"$OUT/environment.txt"

log "Building the Computer and installer inputs from the checkout snapshot"
step build-sync bash -c "
  set -e
  mkdir -p '$SRC'
  find '$SRC' -mindepth 1 -maxdepth 1 ! -name node_modules ! -name .git -exec rm -rf {} +
  (cd '$REPO' && tar --exclude=node_modules --exclude=./.worktrees --exclude=./target --exclude=./.amp --exclude=./.git -cf - .) | tar -C '$SRC' -xf -
  cd '$SRC'
  git init -q 2>/dev/null || true
  git add -A >/dev/null 2>&1
  git -c user.name=e2e -c user.email=e2e@localhost commit -qm 'installer-linux E2E snapshot of $COMMIT' >/dev/null 2>&1 || true
  mise trust -y . >/dev/null 2>&1 || true
  mise exec -- bun install --frozen-lockfile
  mise exec -- bun run --cwd packages/coforge-sdk generate
  cd crates/installer && mise trust -y . >/dev/null 2>&1 || true
  mise install rust bun >/dev/null 2>&1
"
record build "Source snapshot installs and generates" "exit $STEP_RC" "$([[ $STEP_RC == 0 ]] && echo 0 || echo 1)" "steps/build-sync"
if [[ "$STEP_RC" != 0 ]]; then
  log "build-sync failed; see $OUT/steps/build-sync/stderr"
  exit 1
fi

mkdir -p "$BIN"
step build-installer-default bash -c "cd '$SRC/crates/installer' && unset COFORGE_RELEASE_FEED_URL && mise exec -- cargo build --locked --release"
if [[ "$STEP_RC" == 0 ]]; then cp "$TARGET_DIR/release/coforge-installer" "$INSTALLER"; fi
PROD_LITERAL=$(count 'https://releases.coforge.cn' "$INSTALLER")
record build "Default installer builds with the production feed compiled in" "exit $STEP_RC, production literal found=$PROD_LITERAL" "$([[ $STEP_RC == 0 && $PROD_LITERAL -ge 1 ]] && echo 0 || echo 1)" "steps/build-installer-default"
[[ "$STEP_RC" == 0 ]] || { log "installer build failed"; exit 1; }

step build-installer-loopback bash -c "cd '$SRC/crates/installer' && COFORGE_RELEASE_FEED_URL='$LOOP_FEED' mise exec -- cargo build --locked --release"
if [[ "$STEP_RC" == 0 ]]; then cp "$TARGET_DIR/release/coforge-installer" "$BIN/coforge-installer-loopback"; fi
LOOP_LITERAL=$(count "$LOOP_FEED" "$BIN/coforge-installer-loopback")
record build "Loopback installer compiles $LOOP_FEED in" "exit $STEP_RC, literal found=$LOOP_LITERAL" "$([[ $STEP_RC == 0 && $LOOP_LITERAL -ge 1 ]] && echo 0 || echo 1)" "steps/build-installer-loopback"

# Computer packages. The fixture builder is the one reload-local-computer.sh uses; the overrides
# only fix the version, the output directory and (for scenario 6) the compiled feed.
build_package() { # <name> <version> <feed or empty>
  local name=$1 version=$2 feed=$3
  local env_args=(
    "COFORGE_E2E_WEB_URL=$WEB_URL"
    "COFORGE_E2E_VERSION=$version"
    "COFORGE_E2E_PACKAGE_DIR=$PKG/$version"
  )
  if [[ -n "$feed" ]]; then env_args+=("COFORGE_E2E_RELEASE_FEED_URL=$feed"); fi
  pushd "$SRC" >/dev/null || return 1
  step "build-package-$name" mise exec -- env "${env_args[@]}" bun scripts/e2e/build-computer-fixture.ts
  popd >/dev/null || return 1
  local manifest_version
  manifest_version=$(json_eval "$PKG/$version/manifest.json" "d['version']" 2>/dev/null)
  record "build" "Computer package $version built (feed=${feed:-staging default})" "exit $STEP_RC, manifest version=$manifest_version" "$([[ $STEP_RC == 0 && "$manifest_version" == "$version" ]] && echo 0 || echo 1)" "steps/build-package-$name"
}

rm -rf "$PKG" "$FEED"
mkdir -p "$PKG"
build_package e1 0.1.0-e2e.1 ""
build_package e2 0.1.0-e2e.2 ""
build_package e6-loop 0.1.0-e2e.6 "$LOOP_FEED"
build_package e7-loop 0.1.0-e2e.7 "$LOOP_FEED"

# The broken release: a stub that answers the candidate check (`__lifecycle protocol`) with its
# version and exits 1 for everything else, so the supervisor never comes up. Its manifest is
# written from the real bytes (sizes and checksums of the stub, its gzip and the photon sidecar).
BROKEN="$PKG/0.1.0-e2e.3"
step build-package-e3 bash -c "
  set -e
  mkdir -p '$BROKEN'
  cat > '$BROKEN/coforge-computer' <<'STUB'
#!/bin/sh
# Broken E2E release: passes the candidate check, never brings the supervisor up.
if [ \"\$1\" = __lifecycle ] && [ \"\$2\" = protocol ]; then
  echo '{\"lifecycle_protocol\":1,\"version\":\"0.1.0-e2e.3\"}'
  exit 0
fi
echo 'coforge-computer 0.1.0-e2e.3 (broken E2E build): supervisor cannot start' >&2
exit 1
STUB
  chmod 755 '$BROKEN/coforge-computer'
  gzip -9 -n -c '$BROKEN/coforge-computer' > '$BROKEN/coforge-computer.gz'
  cp '$PKG/0.1.0-e2e.2/photon_rs_bg.wasm' '$BROKEN/'
  python3 -I - '$BROKEN' <<'PY'
import hashlib, json, os, sys
d = sys.argv[1]
def ident(name):
    data = open(os.path.join(d, name), 'rb').read()
    return {'size': len(data), 'checksum': hashlib.sha256(data).hexdigest()}
binary = ident('coforge-computer')
gz = ident('coforge-computer.gz')
photon = ident('photon_rs_bg.wasm')
manifest = {'schema_version': 2, 'version': '0.1.0-e2e.3', 'commit': 'broken-e2e-stub',
            'buildDate': '2026-10-08T00:00:00.000Z',
            'platforms': {'linux-arm64': {'computer': {'binary': 'coforge-computer', **binary,
                          'gzip': {'binary': 'coforge-computer.gz', **gz}}}},
            'photonWasm': {'file': 'photon_rs_bg.wasm', **photon}}
open(os.path.join(d, 'manifest.json'), 'w').write(json.dumps(manifest))
PY
  '$BROKEN/coforge-computer' __lifecycle protocol >/dev/null
"
record build "Broken e2e.3 stub passes its candidate check" "exit $STEP_RC" "$([[ $STEP_RC == 0 ]] && echo 0 || echo 1)" "steps/build-package-e3"

# Local feed for scenario 6: the loopback Computer release and the loopback installer.
step build-feed bash -c "
  set -e
  cd '$SRC' && mise exec -- bun scripts/e2e/installer-linux-feed.ts '$FEED' '$PKG/0.1.0-e2e.7' 0.1.0 '$BIN/coforge-installer-loopback' '$COMMIT'
"
cp "$OUT/steps/build-feed/stdout" "$OUT/feed-manifest-summary.txt" 2>/dev/null || true
record build "Local feed holds the e2e.7 Computer tree and installer 0.1.0" "exit $STEP_RC, $(clean <"$OUT/steps/build-feed/stdout" | cut -c1-160)" "$([[ $STEP_RC == 0 ]] && echo 0 || echo 1)" "steps/build-feed"

# ---------------------------------------------------------------------------------------------
# Scenario 1: fresh install
# ---------------------------------------------------------------------------------------------

reset_vm_state
snapshot "$OUT/steps/s1-before"
step s1-install timeout 420 "$INSTALLER" install --version 0.1.0-e2e.1 --from-directory "$PKG/0.1.0-e2e.1"
record S1 "install --version 0.1.0-e2e.1 --from-directory exits 0" "exit $STEP_RC; last line: $(tail -1 "$OUT/steps/s1-install/stdout")" "$([[ $STEP_RC == 0 ]] && echo 0 || echo 1)" "steps/s1-install"
snapshot "$OUT/steps/s1-after"
R=$(newest_result)
record S1 "active.json current 0.1.0-e2e.1" "$(json_eval "$ROOT/active.json" "d['current']")" "$([[ "$(json_eval "$ROOT/active.json" "d['current']")" == 0.1.0-e2e.1 ]] && echo 0 || echo 1)" "steps/s1-after/active.json"
record S1 "shim ~/.local/bin/coforge-computer points into the active install" "$(readlink "$HOME/.local/bin/coforge-computer" 2>/dev/null || echo missing)" "$([[ "$(readlink "$HOME/.local/bin/coforge-computer" 2>/dev/null)" == "$ROOT/active/coforge-computer" ]] && echo 0 || echo 1)" "steps/s1-after/state.txt"
record S1 "receipt succeeded for 0.1.0-e2e.1" "$(json_eval "${R:-/dev/null}" "d.get('status')")/$(json_eval "${R:-/dev/null}" "d.get('version')")" "$([[ "$(json_eval "${R:-/dev/null}" "d.get('status')")" == succeeded ]] && echo 0 || echo 1)" "steps/s1-after/receipts"

# ---------------------------------------------------------------------------------------------
# Scenario 2: the Computer's own start, then the supervisor unit
# ---------------------------------------------------------------------------------------------

snapshot "$OUT/steps/s2-before"
# Only `coforge-computer setup` writes the unit (packages/daemon/src/daemon-host/systemd-user.ts,
# SystemdUserDaemonHost.ensureStarted), and setup needs a Workspace server this E2E does not have.
# So the unit is registered here with linux-supervisor-unit.ts, which prints the product's own
# systemdUserUnit text; it is enabled and started the way ensureStarted does it, with no Workspace.
step s2-unit bash -c "
  set -e
  cd '$SRC' && mise exec -- bun scripts/e2e/linux-supervisor-unit.ts > '$UNIT'
  systemctl --user daemon-reload
  systemctl --user enable coforge-daemon.service
  systemctl --user start coforge-daemon.service
"
sleep 3
snapshot "$OUT/steps/s2-after"
LC_RUNNING=$(json_eval "$OUT/steps/s2-after/lifecycle.json" "d.get('supervisor',{}).get('running')")
LC_VERSION=$(json_eval "$OUT/steps/s2-after/lifecycle.json" "d.get('supervisor',{}).get('version')")
record S2 "__lifecycle status reports supervisor running 0.1.0-e2e.1 (no Workspace)" "running=$LC_RUNNING version=$LC_VERSION" "$([[ "$LC_RUNNING" == True && "$LC_VERSION" == 0.1.0-e2e.1 ]] && echo 0 || echo 1)" "steps/s2-after/lifecycle.json"
record S2 "systemctl --user reports coforge-daemon.service active" "$(systemctl --user is-active coforge-daemon.service 2>&1)" "$([[ "$(systemctl --user is-active coforge-daemon.service 2>/dev/null)" == active ]] && echo 0 || echo 1)" "steps/s2-after/systemd-status.txt"

# ---------------------------------------------------------------------------------------------
# Scenario 3: upgrade with a running supervisor, then the same request id
# ---------------------------------------------------------------------------------------------

snapshot "$OUT/steps/s3-before"
OLD_PID=$(main_pid)
RID3=$(uuid)
step s3-upgrade timeout 420 "$INSTALLER" upgrade --request-id "$RID3" --version 0.1.0-e2e.2 --from-directory "$PKG/0.1.0-e2e.2"
record S3 "upgrade to 0.1.0-e2e.2 exits 0" "exit $STEP_RC; last line: $(tail -1 "$OUT/steps/s3-upgrade/stdout")" "$([[ $STEP_RC == 0 ]] && echo 0 || echo 1)" "steps/s3-upgrade"
snapshot "$OUT/steps/s3-after"
RES3="$ROOT/upgrade-results/$RID3.result.json"
DEAD=$(json_eval "$RES3" "d.get('deadProcessIdentities',[{}])[0].get('startedAt','')")
DEAD_OK=$(python3 -c 'import re,sys; print(0 if re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9]+", sys.argv[1]) else 1)' "$DEAD")
record S3 "receipt succeeded with deadProcessIdentities in <boot id>:<ticks> form" "status=$(json_eval "$RES3" "d.get('status')"), startedAt=$DEAD" "$([[ "$(json_eval "$RES3" "d.get('status')")" == succeeded && "$DEAD_OK" == 0 ]] && echo 0 || echo 1)" "steps/s3-after/receipts"
NEW_PID=$(main_pid)
LC_VERSION=$(json_eval "$OUT/steps/s3-after/lifecycle.json" "d.get('supervisor',{}).get('version')")
record S3 "supervisor running 0.1.0-e2e.2 under a new pid, old pid gone" "old=$OLD_PID new=$NEW_PID lifecycle=$LC_VERSION" "$([[ "$NEW_PID" != 0 && "$NEW_PID" != "$OLD_PID" && "$LC_VERSION" == 0.1.0-e2e.2 ]] && ! pid_alive "$OLD_PID" && echo 0 || echo 1)" "steps/s3-after/processes.txt"
cp "$ROOT/active.json" "$OUT/steps/s3-upgrade/active-before-replay.json"
cp "$RES3" "$OUT/steps/s3-upgrade/result-before-replay.json"
step s3-replay timeout 420 "$INSTALLER" upgrade --request-id "$RID3" --version 0.1.0-e2e.2 --from-directory "$PKG/0.1.0-e2e.2"
snapshot "$OUT/steps/s3-replay-after"
SAME=1
cmp -s "$OUT/steps/s3-upgrade/active-before-replay.json" "$ROOT/active.json" && cmp -s "$OUT/steps/s3-upgrade/result-before-replay.json" "$RES3" && [[ "$(main_pid)" == "$NEW_PID" ]] && SAME=0
record S3 "same request id replays: exit 0, nothing changes (active.json, receipt, pid)" "exit $STEP_RC; unchanged=$([[ $SAME == 0 ]] && echo yes || echo no)" "$([[ $STEP_RC == 0 && $SAME == 0 ]] && echo 0 || echo 1)" "steps/s3-replay"

# ---------------------------------------------------------------------------------------------
# Scenario 4: broken release, automatic rollback
# ---------------------------------------------------------------------------------------------

snapshot "$OUT/steps/s4-before"
RID4=$(uuid)
step s4-broken timeout 420 "$INSTALLER" upgrade --request-id "$RID4" --version 0.1.0-e2e.3 --from-directory "$PKG/0.1.0-e2e.3"
record S4 "upgrade to broken 0.1.0-e2e.3 exits 1" "exit $STEP_RC" "$([[ $STEP_RC == 1 ]] && echo 0 || echo 1)" "steps/s4-broken"
snapshot "$OUT/steps/s4-after"
RES4="$ROOT/upgrade-results/$RID4.result.json"
record S4 "receipt failed, errorCode UPGRADE_ROLLED_BACK, restoredVersion 0.1.0-e2e.2" "status=$(json_eval "$RES4" "d.get('status')"), errorCode=$(json_eval "$RES4" "d.get('errorCode')"), restoredVersion=$(json_eval "$RES4" "d.get('restoredVersion')")" "$([[ "$(json_eval "$RES4" "d.get('status')")" == failed && "$(json_eval "$RES4" "d.get('errorCode')")" == UPGRADE_ROLLED_BACK && "$(json_eval "$RES4" "d.get('restoredVersion')")" == 0.1.0-e2e.2 ]] && echo 0 || echo 1)" "steps/s4-after/receipts"
LC_VERSION=$(json_eval "$OUT/steps/s4-after/lifecycle.json" "d.get('supervisor',{}).get('version')")
LC_RUNNING=$(json_eval "$OUT/steps/s4-after/lifecycle.json" "d.get('supervisor',{}).get('running')")
record S4 "supervisor running 0.1.0-e2e.2 again" "running=$LC_RUNNING version=$LC_VERSION" "$([[ "$LC_RUNNING" == True && "$LC_VERSION" == 0.1.0-e2e.2 ]] && echo 0 || echo 1)" "steps/s4-after/lifecycle.json"
record S4 "journal gone after the verified rollback" "$([[ -e "$ROOT/installer-transaction.json" ]] && echo present || echo absent)" "$([[ -e "$ROOT/installer-transaction.json" ]] && echo 1 || echo 0)" "steps/s4-after/state.txt"

# The installed version is 0.1.0-e2e.2 after the rollback, so an upgrade to 0.1.0-e2e.1 is a
# downgrade: without --allow-downgrade the installer refuses it before anything changes.
snapshot "$OUT/steps/s4-downgrade-before"
DOWN_PID_BEFORE=$(main_pid)
cp "$ROOT/active.json" "$OUT/steps/s4-downgrade-before/active.json"
RID4D=$(uuid)
step s4-downgrade timeout 120 "$INSTALLER" upgrade --request-id "$RID4D" --version 0.1.0-e2e.1 --from-directory "$PKG/0.1.0-e2e.1"
record S4 "downgrade to 0.1.0-e2e.1 without --allow-downgrade exits 1" "exit $STEP_RC: $(clean <"$OUT/steps/s4-downgrade/stderr" | cut -c1-200)" "$([[ $STEP_RC == 1 ]] && echo 0 || echo 1)" "steps/s4-downgrade"
RES4D="$ROOT/upgrade-results/$RID4D.result.json"
record S4 "refused downgrade receipt: failed, errorCode UPGRADE_DOWNGRADE_REFUSED" "status=$(json_eval "$RES4D" "d.get('status')"), errorCode=$(json_eval "$RES4D" "d.get('errorCode')")" "$([[ "$(json_eval "$RES4D" "d.get('status')")" == failed && "$(json_eval "$RES4D" "d.get('errorCode')")" == UPGRADE_DOWNGRADE_REFUSED ]] && echo 0 || echo 1)" "steps/s4-downgrade/receipts"
DOWN_SAME=1
cmp -s "$OUT/steps/s4-downgrade-before/active.json" "$ROOT/active.json" && [[ "$(main_pid)" == "$DOWN_PID_BEFORE" ]] && [[ ! -e "$ROOT/installer-transaction.json" ]] && DOWN_SAME=0
record S4 "refused downgrade changes nothing: active.json unchanged, supervisor pid unchanged, no journal" "active=$(json_eval "$ROOT/active.json" "d['current']"), pid=$(main_pid), before=$DOWN_PID_BEFORE" "$DOWN_SAME" "steps/s4-downgrade"

# ---------------------------------------------------------------------------------------------
# Scenario 5: SIGKILL right after "Switching the active executable", then recover
# ---------------------------------------------------------------------------------------------

snapshot "$OUT/steps/s5-before"
RID5=$(uuid)
mkdir -p "$OUT/steps/s5-killed"
printf '%s\n' "kill -9 the upgrade to 0.1.0-e2e.1 after its 'Switching the active executable' line" >"$OUT/steps/s5-killed/command.txt"
"$INSTALLER" upgrade --request-id "$RID5" --version 0.1.0-e2e.1 --from-directory "$PKG/0.1.0-e2e.1" \
  --allow-downgrade >"$OUT/steps/s5-killed/stdout" 2>"$OUT/steps/s5-killed/stderr" &
KILL_PID=$!
for _ in $(seq 1 1000); do
  grep -q "Switching the active executable" "$OUT/steps/s5-killed/stdout" 2>/dev/null && break
  sleep 0.02
done
SAW_SWITCH=$(count "Switching the active executable" "$OUT/steps/s5-killed/stdout")
kill -9 "$KILL_PID" 2>/dev/null
wait "$KILL_PID" 2>/dev/null
KILL_RC=$?
echo "$KILL_RC" >"$OUT/steps/s5-killed/exit_code"
record S5 "installer killed (SIGKILL) at the activation stage" "stage seen=$SAW_SWITCH, wait status=$KILL_RC" "$([[ "$SAW_SWITCH" -ge 1 && "$KILL_RC" == 137 ]] && echo 0 || echo 1)" "steps/s5-killed"
snapshot "$OUT/steps/s5-after-kill"
record S5 "journal left by the killed run" "$([[ -e "$ROOT/installer-transaction.json" ]] && echo present || echo absent)" "$([[ -e "$ROOT/installer-transaction.json" ]] && echo 0 || echo 1)" "steps/s5-after-kill/journal.json"
# The installer writes active.json before it syncs `current/` (crates/installer/src/active.rs
# `activate`), and recover settles on what active.json names. A kill can land before the
# active.json write (recover rolls back to the version it named before) or after it (recover
# finishes on the target), with `current/` still on the old version. Both are correct; the
# expectation follows active.json as the kill left it, and `current/version` is recorded beside it.
ACTIVE_AT_KILL=$(json_eval "$ROOT/active.json" "d['current']")
CURRENT_AT_KILL=$(tr -d '\n' <"$ROOT/current/version" 2>/dev/null)
case "$ACTIVE_AT_KILL" in
  0.1.0-e2e.1) EXPECT_STATUS=succeeded; EXPECT_CODE="" ;;
  0.1.0-e2e.2) EXPECT_STATUS=failed; EXPECT_CODE=UPGRADE_ROLLED_BACK ;;
  *) EXPECT_STATUS=unexpected; EXPECT_CODE="" ;;
esac
record S5 "active.json names 0.1.0-e2e.1 (finish on target) or 0.1.0-e2e.2 (roll back)" "active.json=$ACTIVE_AT_KILL, current/version=$CURRENT_AT_KILL" "$([[ "$EXPECT_STATUS" != unexpected ]] && echo 0 || echo 1)" "steps/s5-after-kill/active.json"

RID5B=$(uuid)
step s5-refused timeout 120 "$INSTALLER" upgrade --request-id "$RID5B" --version 0.1.0-e2e.2 --from-directory "$PKG/0.1.0-e2e.2"
record S5 "a new upgrade exits 3 and names coforge-computer recover" "exit $STEP_RC: $(clean <"$OUT/steps/s5-refused/stderr" | cut -c1-200)" "$([[ $STEP_RC == 3 ]] && grep -q 'coforge-computer recover' "$OUT/steps/s5-refused/stderr" && echo 0 || echo 1)" "steps/s5-refused"
record S5 "refused upgrade wrote no receipt" "$([[ -e "$ROOT/upgrade-results/$RID5B.result.json" ]] && echo receipt-present || echo none)" "$([[ -e "$ROOT/upgrade-results/$RID5B.result.json" ]] && echo 1 || echo 0)" "steps/s5-refused"

step s5-recover timeout 420 "$INSTALLER" recover
record S5 "coforge-installer recover exits 0" "exit $STEP_RC; last line: $(tail -1 "$OUT/steps/s5-recover/stdout")" "$([[ $STEP_RC == 0 ]] && echo 0 || echo 1)" "steps/s5-recover"
snapshot "$OUT/steps/s5-after"
RES5="$ROOT/upgrade-results/$RID5.result.json"
RES5_STATUS=$(json_eval "$RES5" "d.get('status')")
RES5_CODE=$(json_eval "$RES5" "d.get('errorCode')")
RES5_VERSION=$(json_eval "$RES5" "d.get('version') or d.get('restoredVersion')")
record S5 "receipt for the killed request: $EXPECT_STATUS${EXPECT_CODE:+ ($EXPECT_CODE)} at $ACTIVE_AT_KILL" "status=$RES5_STATUS, errorCode=$RES5_CODE, version=$RES5_VERSION" "$([[ "$RES5_STATUS" == "$EXPECT_STATUS" && "$RES5_CODE" == "${EXPECT_CODE:-None}" && "$RES5_VERSION" == "$ACTIVE_AT_KILL" ]] && echo 0 || echo 1)" "steps/s5-after/receipts"
LC_RUNNING=$(json_eval "$OUT/steps/s5-after/lifecycle.json" "d.get('supervisor',{}).get('running')")
LC_VERSION=$(json_eval "$OUT/steps/s5-after/lifecycle.json" "d.get('supervisor',{}).get('version')")
record S5 "supervisor running $ACTIVE_AT_KILL and healthy after recover" "running=$LC_RUNNING version=$LC_VERSION" "$([[ "$LC_RUNNING" == True && "$LC_VERSION" == "$ACTIVE_AT_KILL" ]] && echo 0 || echo 1)" "steps/s5-after/lifecycle.json"
record S5 "journal gone after recover" "$([[ -e "$ROOT/installer-transaction.json" ]] && echo present || echo absent)" "$([[ -e "$ROOT/installer-transaction.json" ]] && echo 1 || echo 0)" "steps/s5-after/state.txt"

# ---------------------------------------------------------------------------------------------
# Scenario 6: the Computer's own upgrade through the loopback feed
# ---------------------------------------------------------------------------------------------

reset_vm_state
step s6-install timeout 420 "$INSTALLER" install --version 0.1.0-e2e.6 --from-directory "$PKG/0.1.0-e2e.6"
record S6 "precondition: loopback Computer 0.1.0-e2e.6 installs (feed compiled in)" "exit $STEP_RC" "$([[ $STEP_RC == 0 ]] && echo 0 || echo 1)" "steps/s6-install"
step s6-unit bash -c "
  set -e
  cd '$SRC' && mise exec -- bun scripts/e2e/linux-supervisor-unit.ts > '$UNIT'
  systemctl --user daemon-reload
  systemctl --user enable coforge-daemon.service
  systemctl --user start coforge-daemon.service
"
sleep 3
# The stock HTTP/1.0 server on purpose: the installer opens a fresh connection per request, and this
# feed proves it. The request log (one line per request, on stderr) is the feed-server.log evidence.
python3 -I -m http.server "$LOOP_PORT" --bind 127.0.0.1 --directory "$FEED" >"$OUT/feed-server.log" 2>&1 &
FEED_PID=$!
# An interrupted run must not leave the server holding the port for the next one.
trap 'kill "$FEED_PID" 2>/dev/null' EXIT
for _ in $(seq 1 100); do
  curl -fsS "$LOOP_FEED/latest" >/dev/null 2>&1 && break
  sleep 0.1
done
record S6 "loopback feed serves installer/latest and the e2e.7 Computer tree" "latest=$(curl -fsS "$LOOP_FEED/installer/latest" 2>/dev/null | tr -d '\n'), computer latest=$(curl -fsS "$LOOP_FEED/latest" 2>/dev/null | tr -d '\n')" "$([[ "$(curl -fsS "$LOOP_FEED/latest" 2>/dev/null | tr -d '\n')" == 0.1.0-e2e.7 ]] && echo 0 || echo 1)" "feed-server.log"
snapshot "$OUT/steps/s6-before"
step s6-computer-upgrade bash -c "printf 'y\n' | timeout 420 '$ROOT/active/coforge-computer' upgrade --version 0.1.0-e2e.7"
record S6 "coforge-computer upgrade --version 0.1.0-e2e.7 exits 0" "exit $STEP_RC; last line: $(tail -1 "$OUT/steps/s6-computer-upgrade/stdout") $(tail -1 "$OUT/steps/s6-computer-upgrade/stderr")" "$([[ $STEP_RC == 0 ]] && echo 0 || echo 1)" "steps/s6-computer-upgrade"
snapshot "$OUT/steps/s6-after"
R6=$(newest_result)
record S6 "the Computer's upgrade ends with the installer's receipt (succeeded 0.1.0-e2e.7)" "status=$(json_eval "${R6:-/dev/null}" "d.get('status')"), version=$(json_eval "${R6:-/dev/null}" "d.get('version')")" "$([[ "$(json_eval "${R6:-/dev/null}" "d.get('status')")" == succeeded && "$(json_eval "${R6:-/dev/null}" "d.get('version')")" == 0.1.0-e2e.7 ]] && echo 0 || echo 1)" "steps/s6-after/receipts"
FETCHED=$(count 'installer/latest\|installer/0.1.0/manifest.json\|linux-arm64/coforge-installer.gz' "$OUT/feed-server.log")
record S6 "the installer was fetched from the loopback feed" "feed requests for installer objects=$FETCHED" "$([[ "$FETCHED" -ge 3 ]] && echo 0 || echo 1)" "feed-server.log"
record S6 "active Computer 0.1.0-e2e.7 running under the supervisor" "$(json_eval "$OUT/steps/s6-after/lifecycle.json" "d.get('supervisor',{}).get('version')")" "$([[ "$(json_eval "$OUT/steps/s6-after/lifecycle.json" "d.get('supervisor',{}).get('version')")" == 0.1.0-e2e.7 ]] && echo 0 || echo 1)" "steps/s6-after/lifecycle.json"

kill "$FEED_PID" 2>/dev/null
wait "$FEED_PID" 2>/dev/null

# ---------------------------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------------------------

{
  echo "# Linux installer and Computer upgrade E2E"
  echo
  echo "- Run (UTC): $STAMP"
  echo "- Commit: \`$COMMIT\` (uncommitted paths in the checkout: $DIRTY)"
  echo "- Host: coforge-linux (Ubuntu 24.04 arm64, OrbStack VM)"
  echo "- Result: $([[ $FAILURES == 0 ]] && echo "all rows pass" || echo "$FAILURES row(s) fail")"
  echo
  echo "| Scenario | Expected | Observed | Result | Evidence |"
  echo "| --- | --- | --- | --- | --- |"
  tick=$(printf '\x60')
  while IFS=$'\t' read -r scenario expected observed status evidence; do
    printf '| %s | %s | %s | %s | %s%s%s |\n' "$scenario" "$expected" "$observed" "$status" "$tick" "$evidence" "$tick"
  done <"$RESULTS"
} >"$OUT/summary.md"

cat "$OUT/summary.md"
[[ $FAILURES == 0 ]]
