#!/usr/bin/env bash
# The supervisor stays up, replaces the child on USR1, and exits on TERM.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
supervise="${root}/scripts/supervise-computer-runtime.sh"
restart="${root}/scripts/restart-computer-runtime.sh"
tmp="$(mktemp -d)"
trap 'kill "${supervisor:-}" 2>/dev/null || true; rm -rf "${tmp}"' EXIT

cat > "${tmp}/first" <<'EOF'
#!/bin/sh
echo first > "$COFORGE_TEST_MARKER"
sleep 60
EOF
cat > "${tmp}/second" <<'EOF'
#!/bin/sh
echo second > "$COFORGE_TEST_MARKER"
sleep 60
EOF
chmod 755 "${tmp}/first" "${tmp}/second"
cat > "${tmp}/select" <<EOF
#!/bin/bash
if [[ -f "${tmp}/use-second" ]]; then
  printf '%s\n' "${tmp}/second"
else
  printf '%s\n' "${tmp}/first"
fi
EOF
chmod 755 "${tmp}/select"

export COFORGE_SELECT_COMPUTER_BIN="${tmp}/select"
export COFORGE_IMAGE_COMPUTER_BIN="${tmp}/first"
export COFORGE_RUNTIME_PIDFILE="${tmp}/runtime.pid"
export COFORGE_RUNTIME_RESTART_DELAY=0
export COFORGE_TEST_MARKER="${tmp}/marker"

bash "${supervise}" >"${tmp}/supervise.out" 2>"${tmp}/supervise.err" &
supervisor=$!
for _i in 1 2 3 4 5 6 7 8 9 10; do
  [[ -s "${tmp}/runtime.pid" && "$(cat "${tmp}/marker" 2>/dev/null || true)" == "first" ]] && break
  sleep 0.1
done
[[ "$(cat "${tmp}/marker")" == "first" ]]
first_pid="$(tr -d '[:space:]' < "${tmp}/runtime.pid")"
kill -0 "${first_pid}"
kill -0 "${supervisor}"

touch "${tmp}/use-second"
COFORGE_RUNTIME_SUPERVISOR_PID="${supervisor}" bash "${restart}"
[[ "$(cat "${tmp}/marker")" == "second" ]]
second_pid="$(tr -d '[:space:]' < "${tmp}/runtime.pid")"
[[ "${second_pid}" != "${first_pid}" ]]
kill -0 "${second_pid}"
kill -0 "${supervisor}"
! kill -0 "${first_pid}" 2>/dev/null

kill -TERM "${supervisor}"
for _i in 1 2 3 4 5 6 7 8 9 10; do
  kill -0 "${supervisor}" 2>/dev/null || break
  sleep 0.1
done
! kill -0 "${supervisor}" 2>/dev/null
! kill -0 "${second_pid}" 2>/dev/null
echo "supervise-computer-runtime ok"
