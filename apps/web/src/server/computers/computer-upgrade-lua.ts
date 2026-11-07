/** The upgrade store's Redis Lua: request-record compare-and-replace writes and the
 * monotonic identity guard every ready and completion shares. */

export const REPLACE = `if redis.call("GET", KEYS[1]) == ARGV[1] then redis.call("SET", KEYS[1], ARGV[2], "EX", ARGV[3]); return 1 end return 0`;
/** Replaces an accepted request's record only while it still reads accepted. */
export const REPLACE_IF_ACCEPTED = `if redis.call("GET", KEYS[1]) == ARGV[1] and cjson.decode(ARGV[1]).status == "accepted" then redis.call("SET", KEYS[1], ARGV[2], "EX", ARGV[3]); return 1 end return 0`;
/**
 * Identity is a durable snapshot, not a liveness signal - it is overwritten monotonically on
 * every `ready`, never expired. (Precedent: `computer-restart-store.server.ts` stores its own
 * process identity the same way.) Liveness for "can this Computer be upgraded right now" comes
 * from Computer presence (`computer-status.server.ts`), which is re-leased on every periodic
 * Daemon status and therefore self-heals independently of this key.
 */
export const STORE_NEWER_IDENTITY = `
local current = redis.call("GET", KEYS[1])
local candidate = cjson.decode(ARGV[1])
if current then
  local previous = cjson.decode(current)
  if previous.startedAt > candidate.startedAt or
     (previous.startedAt == candidate.startedAt and previous.workerInstanceId ~= candidate.workerInstanceId) then
    return 0
  end
end
redis.call("SET", KEYS[1], ARGV[1])
return 1`;

export const COMMIT_READY = `
local current = redis.call("GET", KEYS[1])
local identity = redis.call("GET", KEYS[2])
local candidate = cjson.decode(ARGV[2])
if identity then
  local previous = cjson.decode(identity)
  if previous.startedAt > candidate.startedAt or
     (previous.startedAt == candidate.startedAt and previous.workerInstanceId ~= candidate.workerInstanceId) then
    return 0
  end
end
if current ~= ARGV[1] or cjson.decode(current).status ~= "accepted" then return 0 end
redis.call("SET", KEYS[2], ARGV[2])
redis.call("SET", KEYS[1], ARGV[3], "EX", ARGV[4])
return 1`;

/**
 * One upgrade in flight per Computer. The request's own replay is answered first; then every
 * request id the Computer ever began is checked for an accepted record (settled or expired
 * members are dropped as it goes), with the latest pointer as a fallback for records begun
 * before the set existed. An accepted find reuses that request: the caller gets its status and
 * publishes nothing. Request ids are UUIDs, so a member id concatenated onto the request-key
 * prefix is its key.
 */
export const BEGIN_UPGRADE = `
local own = redis.call("GET", KEYS[1])
if own then return {2, own} end
local prefix = ARGV[3]
local dead = {}
local active = nil
local activeRaw = nil
for _, id in ipairs(redis.call("SMEMBERS", KEYS[3])) do
  local raw = redis.call("GET", prefix .. id)
  local ok, decoded = pcall(cjson.decode, raw or "")
  if raw and ok and type(decoded) == "table" and decoded.status == "accepted" then
    if not active then active = id activeRaw = raw end
  else
    table.insert(dead, id)
  end
end
local latestId = redis.call("GET", KEYS[2])
if latestId and not active and prefix .. latestId ~= KEYS[1] then
  local raw = redis.call("GET", prefix .. latestId)
  local ok, decoded = pcall(cjson.decode, raw or "")
  if raw and ok and type(decoded) == "table" and decoded.status == "accepted" then
    active = latestId activeRaw = raw
  end
end
if #dead > 0 then redis.call("SREM", KEYS[3], unpack(dead)) end
if active then
  -- Enroll a request found only through the latest pointer (begun before the set existed)
  -- so a later ready() settles it with everything else.
  redis.call("SADD", KEYS[3], active)
  redis.call("SET", KEYS[2], active, "EX", ARGV[2])
  return {0, activeRaw}
end
redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[2])
redis.call("SADD", KEYS[3], ARGV[4])
redis.call("SET", KEYS[2], ARGV[4], "EX", ARGV[2])
return {1}`;
