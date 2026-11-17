import { LUA_COMMON } from "./agent-display-lua-common";

const EXTERNAL_LUA = `${LUA_COMMON}
local EXTERNAL_INSTANCE = "external"
local NEVER_EXPIRES = 9007199254740000

local function external_live(state, now)
  return state.process and state.process.status == "active" and not state.processExpired and
    now < state.process.leaseUntil
end

local function external_shown(state, now)
  if not external_live(state, now) then return "offline", "" end
  if state.activityVisible and state.activity then
    return state.activity.kind, state.activity.detail
  end
  return "online", ""
end

local function external_process(status, seen, lease_until)
  return {
    status = status, daemonInstanceId = EXTERNAL_INSTANCE, sequence = 0,
    observedAt = seen, leaseUntil = lease_until
  }
end

local function external_finish(state, now, before_kind, before_detail)
  local kind, detail = external_shown(state, now)
  local changed = kind ~= before_kind or detail ~= before_detail
  if changed then revision(state) end
  save(state)
  if changed then return snapshot(state, ARGV[2], ARGV[3], ARGV[4], now) end
  return false
end
`;

export const OBSERVE_EXTERNAL_PRESENCE = `${EXTERNAL_LUA}
local state = decode_state(redis.call("GET", KEYS[1]))
local now = tonumber(ARGV[1])
local seen = tonumber(ARGV[5])
local window = tonumber(ARGV[6])
project(state, now)
local before_kind, before_detail = external_shown(state, now)
if seen > 0 then
  if state.seenFence and seen <= tonumber(state.seenFence) then return false end
else
  state.seenFence = now
end
local lease_until = seen + window
if seen > 0 and external_live(state, now) and state.process.leaseUntil > lease_until then
  lease_until = state.process.leaseUntil
end
local live = seen > 0 and now < lease_until
if live and state.offlineReport and state.offlineLease and now < state.offlineLease then
  state.offlineLease = lease_until
  save(state)
  return false
end
state.offlineReport = nil
state.offlineLease = nil
if live then
  if before_kind == "offline" then state.activityVisible = false end
  state.process = external_process("active", seen, lease_until)
  state.processExpired = false
else
  state.process = external_process("inactive", seen, cjson.null)
  state.activityVisible = false
end
return external_finish(state, now, before_kind, before_detail)
`;

export const OBSERVE_EXTERNAL_STATUS = `${EXTERNAL_LUA}
local state = decode_state(redis.call("GET", KEYS[1]))
local now = tonumber(ARGV[1])
local kind = ARGV[5]
local detail = ARGV[6]
local occurred = tonumber(ARGV[7])
local reported = ARGV[8] == "1"
local window = tonumber(ARGV[9])
local projected = project(state, now)
if reported then
  if state.reportedAt and occurred <= tonumber(state.reportedAt) then
    return reject_projection(projected, state)
  end
else
  if state.reportedAt then return reject_projection(projected, state) end
  if state.activity and occurred <= tonumber(state.activity.observedAt) then
    return reject_projection(projected, state)
  end
end
local before_kind, before_detail = external_shown(state, now)
if reported then state.reportedAt = occurred end
state.activity = {
  launchId = EXTERNAL_INSTANCE, daemonInstanceId = EXTERNAL_INSTANCE, sequence = 0,
  observedAt = occurred, receivedAt = now, kind = kind, detailKind = "", detail = detail,
  entries = {}, expiresAt = NEVER_EXPIRES
}
if kind == "offline" then
  state.offlineReport = true
  state.offlineLease = now + window
  state.activityVisible = false
  state.process = external_process("inactive", now, cjson.null)
else
  state.offlineReport = nil
  state.offlineLease = nil
  state.activityVisible = true
  state.process = external_process("active", now, now + window)
  state.processExpired = false
end
state.probe = nil
return external_finish(state, now, before_kind, before_detail)
`;
