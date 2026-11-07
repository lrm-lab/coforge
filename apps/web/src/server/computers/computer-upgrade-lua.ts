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
