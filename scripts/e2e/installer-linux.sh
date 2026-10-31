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
#   5  SIGKILL during activation, and a `coforge-installer start` that settles the journal
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

# shellcheck source=scripts/e2e/installer-linux-helpers.sh
source "$REPO/scripts/e2e/installer-linux-helpers.sh"


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
# The unit is registered by `coforge-installer start`; the Computer's `setup` only asks for it
# (SystemdUserDaemonHost.ensureRunning), and setup needs a Workspace server this E2E does not have.
# So the unit is registered here by hand with linux-supervisor-unit.ts, which prints the product's
# own systemdUserUnit text, then enabled and started the way the installer does, with no Workspace.
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

# shellcheck source=scripts/e2e/installer-linux-scenarios-upgrade.sh
source "$REPO/scripts/e2e/installer-linux-scenarios-upgrade.sh"

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
