#!/usr/bin/env bash
# Scenarios 3 to 5 of installer-linux.sh (upgrade, rollback, crash recovery); source it, do not run it.

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
