import { LUA_COMMON } from "./agent-display-lua-common";

// ARGV: [1] now, [2] workspaceId, [3] computerId, [4] agentId, [5] status
// ("active"/"inactive"), [6] daemonInstanceId, [7] clientSeq, [8] observedAtMs,
// [9] status lease ms.
export const OBSERVE_STATUS = `${LUA_COMMON}
local state = decode_state(redis.call("GET", KEYS[1]))
local now = tonumber(ARGV[1])
local projected = project(state, now)
local current = state.process
local same_instance = current and current.daemonInstanceId == ARGV[6]
local accepted = not current
if current then
  if same_instance then
    accepted = tonumber(ARGV[7]) > tonumber(current.sequence) or
      (tonumber(ARGV[7]) == tonumber(current.sequence) and current.status == ARGV[5] and
        tonumber(ARGV[8]) == tonumber(current.observedAt))
  else
    accepted = tonumber(ARGV[8]) > tonumber(current.observedAt)
  end
end
if not accepted then return reject_projection(projected, state) end
-- A fresh active process means the Agent runs again: the stop reason the last failure left
-- no longer describes it, and neither does a failure reason still parked for a lease that
-- never lapsed. "inactive" keeps both — that is the transition the reason explains.
if ARGV[5] == "active" then
  state.stopReason = nil
  state.stopDetail = nil
  state.pendingStopReason = nil
  state.pendingStopDetail = nil
end

local preserve_provisional = not current and state.activityVisible and state.activity and
  state.activity.daemonInstanceId == ARGV[6]
local reset_activity = (current and (not same_instance or current.status == "inactive")) or ARGV[5] == "inactive"
if reset_activity or (not preserve_provisional and not current) then state.activityVisible = false end
-- The process going inactive, or a different daemon instance taking over, makes any
-- stored context-window reading and service-tier reading stale.
if reset_activity then
  state.contextUsage = nil
  state.serviceTier = nil
end
state.process = {
  status = ARGV[5], daemonInstanceId = ARGV[6], sequence = tonumber(ARGV[7]),
  observedAt = tonumber(ARGV[8]), leaseUntil = ARGV[5] == "active" and
    now + tonumber(ARGV[9]) or cjson.null
}
state.processExpired = false
-- Any accepted observation is real evidence from the daemon, so it cancels a
-- pending liveness probe the same way a real Activity observation does.
state.probe = nil
-- An accepted "inactive" is itself the offline transition a parked failure reason was
-- waiting for; promote it now so this very response already carries the reason.
promote_pending_stop(state, now)
if ARGV[5] == "inactive" then
  redis.call("ZREM", KEYS[3], ARGV[2] .. ":" .. ARGV[3] .. ":" .. ARGV[4])
end
revision(state)
save(state)
return snapshot(state, ARGV[2], ARGV[3], ARGV[4], now)
`;

// ARGV: [1] now, [2] workspaceId, [3] computerId, [4] agentId, [5] activity kind,
// [6] detailKind, [7] launchId, [8] daemonInstanceId (the reporting fence),
// [9] launchId (the reporting fence), [10] clientSeq, [11] observedAtMs, [12] detail,
// [13] entries JSON, [14] working lease ms, [15] filler ("1"/"0"),
// [16] runtime error reason ("" when absent), [17] provider message ("" when absent).
export const OBSERVE_ACTIVITY = `${LUA_COMMON}
local state = decode_state(redis.call("GET", KEYS[1]))
local now = tonumber(ARGV[1])
local projected = project(state, now)
if ARGV[7] ~= ARGV[9] then return reject_projection(projected, state) end
-- A launch that fails before its process ever reports active still explains why the Agent is
-- offline: the daemon reports "inactive" first, then the failed launch's error Activity. Let
-- exactly that frame through to record the stop reason; every other offline Activity drops as
-- before. "New launch" means a launchId no recorded Activity or retired launch has claimed,
-- newer than the last recorded Activity and the last recorded failure — the same bounded
-- best-effort ordering the cross-launch fence already is.
-- Trade-off: recording the failure overwrites retiredLaunchId, and only one retired launchId
-- is kept, so the launch retired before it loses its dedicated fence. Accepted: that launch
-- predates the recorded failure, so its late frames already lose on observedAt ordering.
local record_reason = false
if state.process and state.process.daemonInstanceId == ARGV[8] and ARGV[16] ~= "" and
    (state.process.status ~= "active" or now >= state.process.leaseUntil) then
  local unseen = not state.activity or
    (state.activity.launchId ~= ARGV[7] and tonumber(ARGV[11]) > tonumber(state.activity.observedAt))
  local newer = not state.stopLaunch or tonumber(ARGV[11]) > tonumber(state.stopLaunch.observedAt)
  record_reason = unseen and newer and state.retiredLaunchId ~= ARGV[7]
end
if state.process then
  local offline = state.process.status ~= "active" or now >= state.process.leaseUntil
  if state.process.daemonInstanceId ~= ARGV[8] or (offline and not record_reason) then
    return reject_projection(projected, state) end
end
if record_reason then
  state.stopReason = ARGV[16]
  state.stopDetail = ARGV[17] ~= "" and ARGV[17] or nil
  state.pendingStopReason = nil
  state.pendingStopDetail = nil
  state.stopLaunch = { launchId = ARGV[7], observedAt = tonumber(ARGV[11]) }
  state.retiredLaunchId = ARGV[7]
  revision(state)
  save(state)
  return snapshot(state, ARGV[2], ARGV[3], ARGV[4], now)
end
local previous = state.activity
local was_visible = state.activityVisible
local previous_stop_reason = state.stopReason
if state.retiredLaunchId == ARGV[7] then return reject_projection(projected, state) end
if previous then
  if previous.launchId == ARGV[7] then
    if tonumber(ARGV[10]) <= tonumber(previous.sequence) then return reject_projection(projected, state) end
  else
    if tonumber(ARGV[11]) <= tonumber(previous.observedAt) then return reject_projection(projected, state) end
    -- Retain one retired launch only. Cross-launch observedAt ordering is a bounded
    -- best-effort fence, not permanent history or a database race fence.
    state.retiredLaunchId = previous.launchId
    -- A context-window reading from the launch just retired is stale.
    if state.contextUsage and state.contextUsage.launchId == previous.launchId then
      state.contextUsage = nil
    end
    -- The service-tier reading belongs to that launch too.
    if state.serviceTier and state.serviceTier.launchId == previous.launchId then
      state.serviceTier = nil
    end
  end
end
-- A busy heartbeat or a content-free runtime_progress frame (ARGV[15] == "1")
-- only renews the lease below; it bumps the revision counter (and so the
-- realtime push) only when it actually changes what is shown.
local is_filler = ARGV[15] == "1"
local visible_changed = not was_visible or not previous or
  previous.kind ~= ARGV[5] or previous.detailKind ~= ARGV[6] or previous.detail ~= ARGV[12] or
  (ARGV[16] ~= "" and previous_stop_reason ~= ARGV[16])
state.activity = {
  launchId = ARGV[7], daemonInstanceId = ARGV[8], sequence = tonumber(ARGV[10]),
  observedAt = tonumber(ARGV[11]), receivedAt = now, kind = ARGV[5],
  detailKind = ARGV[6], detail = ARGV[12], entries = cjson.decode(ARGV[13]),
  expiresAt = (ARGV[5] == "working" or ARGV[5] == "thinking") and
    now + tonumber(ARGV[14]) or cjson.null
}
state.activityVisible = true
-- A runtime error's reason outlives the Activity itself: the "inactive" status that follows
-- hides the Activity, and the snapshot keeps reporting this until the next active process.
-- A later non-error observation proves the Agent kept running past the error, so the reason
-- no longer describes a stop; an error-kind frame without a reason keeps the last one.
if ARGV[16] ~= "" then
  state.stopReason = ARGV[16]
  state.stopDetail = ARGV[17] ~= "" and ARGV[17] or nil
  state.pendingStopReason = nil
  state.pendingStopDetail = nil
elseif ARGV[5] ~= "error" then
  state.stopReason = nil
  state.stopDetail = nil
  state.pendingStopReason = nil
  state.pendingStopDetail = nil
end
-- Any accepted observation is real evidence from the daemon (a probe reply
-- included), so it cancels a pending liveness probe outright.
state.probe = nil
local lease_member = ARGV[2] .. ":" .. ARGV[3] .. ":" .. ARGV[4]
if ARGV[5] == "working" or ARGV[5] == "thinking" then
  redis.call("ZADD", KEYS[3], state.activity.expiresAt, lease_member)
else
  redis.call("ZREM", KEYS[3], lease_member)
end
if not is_filler or visible_changed then revision(state) end
save(state)
return snapshot(state, ARGV[2], ARGV[3], ARGV[4], now)
`;

// ARGV: [1] now, [2] workspaceId, [3] computerId, [4] agentId, [5] stop reason,
// [6] provider words ("" when the settling path carries none).
// A control operation that settles failed is the one place every managed launch failure
// passes through, including paths whose runtime_error Activity never reached the display
// (a reused launchId the Activity fence already claimed, an older Daemon). The reason it
// carries is the same LAUNCH_FAILURE_REASON vocabulary the Activity's errorReason uses.
// A live process never shows the reason: under a live lease it parks as pending, and
// project() promotes it the moment the display goes offline — the lease proving the
// process live is often the stale one a failed launch leaves behind, so dropping the
// write would lose the reason exactly when it is needed. A genuinely running Agent's
// next status or Activity clears it, same lifecycle as stopReason. A bare re-record
// of the same reason keeps provider words an Activity already wrote; a different reason
// replaces both, since the old words described the old failure.
export const RECORD_STOP_REASON = `${LUA_COMMON}
local state = decode_state(redis.call("GET", KEYS[1]))
local now = tonumber(ARGV[1])
local projected = project(state, now)
local reason = ARGV[5]
if reason == "" then return reject_projection(projected, state) end
local process = state.process
local offline = not process or process.status ~= "active" or now >= process.leaseUntil
local detail = ARGV[6] ~= "" and ARGV[6] or nil
if not offline then
  local pending_detail = detail
  if state.pendingStopReason == reason and detail == nil then
    pending_detail = state.pendingStopDetail
  end
  if state.pendingStopReason == reason and state.pendingStopDetail == pending_detail then
    return reject_projection(projected, state)
  end
  state.pendingStopReason = reason
  state.pendingStopDetail = pending_detail
  revision(state)
  save(state)
  return snapshot(state, ARGV[2], ARGV[3], ARGV[4], now)
end
local stop_detail = detail
if state.stopReason == reason and detail == nil then stop_detail = state.stopDetail end
if state.stopReason == reason and state.stopDetail == stop_detail then
  return reject_projection(projected, state)
end
state.stopReason = reason
state.stopDetail = stop_detail
state.pendingStopReason = nil
state.pendingStopDetail = nil
revision(state)
save(state)
return snapshot(state, ARGV[2], ARGV[3], ARGV[4], now)
`;

// ARGV: [1] now, [2] workspaceId, [3] computerId, [4] agentId, [5] launchId,
// [6] daemonInstanceId, [7] clientSeq, [8] observedAtMs, [9] usedTokens, [10] windowTokens
export const PUT_CONTEXT_USAGE = `${LUA_COMMON}
local state = decode_state(redis.call("GET", KEYS[1]))
local now = tonumber(ARGV[1])
local projected = project(state, now)
local launch_id = ARGV[5]
local daemon_instance_id = ARGV[6]
local client_seq = tonumber(ARGV[7])
local observed_at = tonumber(ARGV[8])
local used_tokens = tonumber(ARGV[9])
local window_tokens = tonumber(ARGV[10])
local current = state.contextUsage
-- Same ordering shape OBSERVE_STATUS uses for state.process: a same-daemon-instance replay
-- must advance clientSeq; a different daemon instance's own reading only advances by wall time.
local same_instance = current and current.daemonInstanceId == daemon_instance_id
local accepted = not current
if current then
  if same_instance then
    accepted = client_seq > current.clientSeq
  else
    accepted = observed_at > current.observedAt
  end
end
if not accepted then return reject_projection(projected, state) end
local changed = not current or current.usedTokens ~= used_tokens or current.windowTokens ~= window_tokens
state.contextUsage = {
  launchId = launch_id, daemonInstanceId = daemon_instance_id, clientSeq = client_seq,
  observedAt = observed_at, usedTokens = used_tokens, windowTokens = window_tokens
}
if changed then revision(state) end
save(state)
return snapshot(state, ARGV[2], ARGV[3], ARGV[4], now)
`;

// ARGV: [1] now, [2] workspaceId, [3] computerId, [4] agentId, [5] launchId,
// [6] daemonInstanceId, [7] clientSeq, [8] observedAtMs, [9] requested ("1"/"0"), [10] observed.
// The ordering fence is PUT_CONTEXT_USAGE's exactly: a same-daemon-instance replay must advance
// clientSeq, and a different daemon instance's own reading only advances by wall time.
export const PUT_SERVICE_TIER = `${LUA_COMMON}
local state = decode_state(redis.call("GET", KEYS[1]))
local now = tonumber(ARGV[1])
local projected = project(state, now)
local launch_id = ARGV[5]
local daemon_instance_id = ARGV[6]
local client_seq = tonumber(ARGV[7])
local observed_at = tonumber(ARGV[8])
local requested = ARGV[9] == "1"
local observed = ARGV[10]
local current = state.serviceTier
local accepted = not current
if current then
  if current.daemonInstanceId == daemon_instance_id then
    accepted = client_seq > current.clientSeq
  else
    accepted = observed_at > current.observedAt
  end
end
if not accepted then return reject_projection(projected, state) end
local changed = not current or current.requested ~= requested or current.observed ~= observed
state.serviceTier = {
  launchId = launch_id, daemonInstanceId = daemon_instance_id, clientSeq = client_seq,
  observedAt = observed_at, requested = requested, observed = observed
}
if changed then revision(state) end
save(state)
return snapshot(state, ARGV[2], ARGV[3], ARGV[4], now)
`;

// ARGV: [1] now, then one [workspaceId, computerId, agentId] triplet per scope, in the same
// order as the state/revision key pairs in KEYS. Answers as fresh as the single-scope reads
// they replace.
export const SNAPSHOT_MANY = `${LUA_COMMON}
local now = tonumber(ARGV[1])
local out = {}
for index = 0, #KEYS / 2 - 1 do
  local base = index * 3 + 2
  out[#out + 1] = take_snapshot(
    index * 2 + 1, index * 2 + 2, ARGV[base], ARGV[base + 1], ARGV[base + 2], now)
end
return out
`;

// ARGV: [1] now, [2] workspaceId, [3] computerId, [4] agentId, [5] probeId, [6] probeTimeoutMs
//
// Deliberately does not call the shared project() helper: project() itself
// flips activityVisible off once a busy lease naturally lapses, which would
// destroy the very "stale but not yet probed" signal this script needs to
// see before that lazy projection is allowed to happen.
export const SWEEP_STALE = `${LUA_COMMON}
local state = decode_state(redis.call("GET", KEYS[1]))
local now = tonumber(ARGV[1])
local probe_id = ARGV[5]
local timeout_ms = tonumber(ARGV[6])
local member = ARGV[2] .. ":" .. ARGV[3] .. ":" .. ARGV[4]
local process_alive = state.process and state.process.status == "active" and
  not state.processExpired and now < state.process.leaseUntil
local busy_visible = process_alive and state.activityVisible and state.activity and
  (state.activity.kind == "working" or state.activity.kind == "thinking")
if not busy_visible then
  redis.call("ZREM", KEYS[3], member)
  return cjson.encode({ outcome = "fresh" })
end
if tonumber(state.activity.expiresAt) > now then
  -- The lease was renewed (a heartbeat or a real observation landed) between
  -- the ZRANGEBYSCORE read that found this member and this call. Re-index at
  -- its new score instead of dropping it, or a lease renewed in that narrow
  -- window would silently fall out of the sweep until it goes stale again.
  redis.call("ZADD", KEYS[3], state.activity.expiresAt, member)
  return cjson.encode({ outcome = "fresh" })
end
if state.probe then
  if now - tonumber(state.probe.sentAt) < timeout_ms then
    return cjson.encode({ outcome = "waiting" })
  end
  state.activityVisible = false
  state.probe = nil
  revision(state)
  save(state)
  redis.call("ZREM", KEYS[3], member)
  return cjson.encode({
    outcome = "expired",
    snapshot = cjson.decode(snapshot(state, ARGV[2], ARGV[3], ARGV[4], now))
  })
end
state.probe = { id = probe_id, sentAt = now }
save(state)
return cjson.encode({ outcome = "probe" })
`;
