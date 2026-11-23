import { REDIS_NOW_MS_LUA } from "#src/server/app-notifications/presence-expiry.server";

export const COMPUTER_INSTALLER_RECOVERY_LEASE_MS = 90_000;

export const COMPUTER_INSTALLER_RECOVERY = `
local raw = redis.call("GET", KEYS[1])
if not raw then return "" end
local ok, identity = pcall(cjson.decode, raw)
if not ok or type(identity) ~= "table" then return "" end
local update = cjson.decode(ARGV[1])
local state = identity.installerRecovery
${REDIS_NOW_MS_LUA}
local lease_ms = ${COMPUTER_INSTALLER_RECOVERY_LEASE_MS}
local function save()
  redis.call("SET", KEYS[1], cjson.encode(identity))
end
if update.kind == "read" then
  if not state or state.closed or not state.required or state.visibleUntilMs <= now_ms then
    return ""
  end
  return cjson.encode({
    workerInstanceId = identity.workerInstanceId,
    startedAt = identity.startedAt,
    client = state.client,
    connectionSequence = state.connectionSequence,
    remainingMs = state.visibleUntilMs - now_ms
  })
end
if identity.workerInstanceId ~= update.workerInstanceId or
   (update.startedAt and identity.startedAt ~= update.startedAt) then return "" end
if update.kind == "ready" then
  if state and state.connectionSequence >= update.connectionSequence then return "" end
  identity.installerRecovery = {
    client = update.client,
    connectionSequence = update.connectionSequence,
    sampleSequence = 0,
    generation = 1,
    challenge = update.nextToken,
    challengeIssuedAtMs = now_ms,
    required = false,
    visibleUntilMs = 0
  }
  save()
  return "ready"
end
if not state or state.client ~= update.client or
   state.connectionSequence ~= update.connectionSequence or state.closed then return "" end
if update.kind == "close" then
  state.closed = true
  state.required = false
  save()
  return ""
end
local function reply()
  return cjson.encode({ token = state.challenge, generation = state.generation })
end
local function rotate()
  state.generation = state.generation + 1
  state.challenge = update.nextToken
  state.challengeIssuedAtMs = now_ms
  save()
  return reply()
end
if now_ms >= state.challengeIssuedAtMs + lease_ms then
  if not update.live then return "presence" end
  return rotate()
end
local sample = update.sample
if sample.challenge == state.challenge and sample.sampleSequence > state.sampleSequence then
  state.sampleSequence = sample.sampleSequence
  state.required = sample.required
  state.visibleUntilMs = state.challengeIssuedAtMs + lease_ms
  return rotate()
end
return reply()
`;
