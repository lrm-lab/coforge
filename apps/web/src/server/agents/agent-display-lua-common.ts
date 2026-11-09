export const LUA_COMMON = `
local function decode_state(raw)
  if not raw then return {} end
  local ok, state = pcall(cjson.decode, raw)
  if not ok or type(state) ~= "table" then return {} end
  return state
end

local function revision(state, revision_key)
  -- The single-scope scripts call this with the keys execute already put in place, so the default
  -- keeps them exactly as they were; the batch reader passes each scope's own index instead.
  revision_key = revision_key or KEYS[2]
  local redis_time = redis.call("TIME")
  local server_time_floor = tonumber(redis_time[1]) * 1000000 + tonumber(redis_time[2])
  local stored_revision = tonumber(redis.call("GET", revision_key)) or 0
  local state_revision = tonumber(state.revision) or 0
  local next_revision = math.max(server_time_floor, stored_revision + 1, state_revision + 1)
  local encoded_revision = string.format("%.0f", next_revision)
  -- The counter deliberately outlives the 24-hour display state. Redis TIME is
  -- the fallback lower bound when eviction or a datastore reset removes both.
  -- Keep the revision as a string inside Redis because cjson encodes Lua numbers
  -- with only 14 significant digits, below the precision of this microsecond value.
  redis.call("SET", revision_key, encoded_revision)
  state.revision = encoded_revision
  return next_revision
end

local function save(state, state_key)
  state_key = state_key or KEYS[1]
  redis.call("SET", state_key, cjson.encode(state), "EX", 86400)
end

-- A control failure recorded while the display still saw a live process parks its reason
-- as pending (RECORD_STOP_REASON): that lease is often the stale one a failed launch
-- leaves behind, so dropping the write would lose the reason exactly when it is needed.
-- The moment the display goes offline the parked reason becomes the stop reason, in the
-- same lazy transition that flips the kind — no sweep, no second store. A genuinely
-- running Agent's next status or Activity clears it exactly like stopReason.
local function promote_pending_stop(state, now)
  local process = state.process
  local offline = not process or process.status ~= "active" or now >= process.leaseUntil
  if offline and not state.stopReason and state.pendingStopReason then
    state.stopReason = state.pendingStopReason
    state.stopDetail = state.pendingStopDetail
    state.pendingStopReason = nil
    state.pendingStopDetail = nil
    return true
  end
  return false
end

local function project(state, now, revision_key)
  local changed = false
  if state.process and state.process.status == "active" and not state.processExpired and
      now >= state.process.leaseUntil then
    state.processExpired = true
    state.activityVisible = false
    changed = true
  elseif state.process and state.process.status == "active" and not state.processExpired and
      state.activityVisible and state.activity and
      (state.activity.kind == "working" or state.activity.kind == "thinking") and
      now >= state.activity.expiresAt then
    state.activityVisible = false
    changed = true
  end
  if promote_pending_stop(state, now) then changed = true end
  if changed then revision(state, revision_key) end
  return changed
end

local function snapshot(state, workspace_id, computer_id, agent_id, now)
  local active = state.process and state.process.status == "active" and not state.processExpired and
    now < state.process.leaseUntil
  local kind = "offline"
  local detail_kind = ""
  local detail = ""
  local entries = {}
  local expires_at = cjson.null
  local context_usage = cjson.null
  local fast_mode = cjson.null
  local stop_reason = cjson.null
  local stop_detail = cjson.null
  local stop_message = cjson.null
  if active then
    kind = "online"
    expires_at = state.process.leaseUntil
    if state.activityVisible and state.activity then
      kind = state.activity.kind
      detail_kind = state.activity.detailKind
      detail = state.activity.detail
      entries = state.activity.entries or {}
      if kind == "working" or kind == "thinking" then
        if state.activity.expiresAt < expires_at then expires_at = state.activity.expiresAt end
      end
    end
    -- AgentStatus carries no launch id, so the strongest fence available here is
    -- "the same daemon instance the active process reports" plus "not a launch OBSERVE_ACTIVITY
    -- has since retired" — the same bounded, best-effort fence retiredLaunchId already is, not a
    -- database race fence. A dead/superseded launch's reading never paints the badge.
    if state.contextUsage and state.contextUsage.daemonInstanceId == state.process.daemonInstanceId and
        state.contextUsage.launchId ~= state.retiredLaunchId then
      context_usage = {
        usedTokens = state.contextUsage.usedTokens, windowTokens = state.contextUsage.windowTokens,
        observedAtMs = state.contextUsage.observedAt
      }
    end
    -- Same bounded, best-effort fence as the context-window reading above: the launch that
    -- observed this tier must be the one the active process belongs to and not already retired.
    if state.serviceTier and state.serviceTier.daemonInstanceId == state.process.daemonInstanceId and
        state.serviceTier.launchId ~= state.retiredLaunchId then
      fast_mode = {
        requested = state.serviceTier.requested, observed = state.serviceTier.observed,
        observedAtMs = state.serviceTier.observedAt
      }
    end
  end
  -- The reason the last runtime failure stopped the Agent survives the Activity reset the
  -- "inactive" status performs; it is only meaningful while the Agent is offline.
  if kind == "offline" and state.stopReason then
    stop_reason = state.stopReason
    stop_detail = state.stopDetail or cjson.null
    stop_message = state.stopMessage or cjson.null
  end
  return cjson.encode({
    protocolMajor = 1, workspaceId = workspace_id, computerId = computer_id,
    agentId = agent_id, revision = state.revision, activityKind = kind,
    detailKind = detail_kind, detail = detail, entries = entries, expiresAt = expires_at,
    contextUsage = context_usage, fastMode = fast_mode, stopReason = stop_reason,
    stopDetail = stop_detail, stopMessage = stop_message
  })
end

-- One scope's snapshot, read and projected exactly as the single-scope reader always did. The key
-- indices are parameters so the batch reader below can answer many scopes in one round trip; the
-- helpers fall back to the keys execute already put in place, which is what keeps the other
-- scripts on this shared preamble unchanged.
local function take_snapshot(state_index, revision_index, workspace_id, computer_id, agent_id, now)
  local state_key = KEYS[state_index]
  local revision_key = KEYS[revision_index]
  local raw = redis.call("GET", state_key)
  local state = decode_state(raw)
  local changed = project(state, now, revision_key)
  if not raw then revision(state, revision_key) changed = true end
  if changed then save(state, state_key) end
  return snapshot(state, workspace_id, computer_id, agent_id, now)
end

-- Every writer's reject path: a lazy projection may have changed the state, so persist it before
-- answering "not accepted".
local function reject_projection(projected, state)
  if projected then save(state) end
  return false
end
`;
