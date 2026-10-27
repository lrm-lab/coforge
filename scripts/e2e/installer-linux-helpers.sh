#!/usr/bin/env bash
# Helper functions of installer-linux.sh; source it, do not run it.

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
