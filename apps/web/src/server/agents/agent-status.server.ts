import { openRedisClient } from "#src/server/redis-client.server";
import { redisUrlFor } from "#src/server/redis-url.server";
import type { AgentStatus } from "@lrm/coforge-sdk/internal";
import { workspaceRedisKey } from "#src/server/redis-keys.server";
import {
  PRESENCE_EXPIRY_KEY,
  REDIS_NOW_MS_LUA,
} from "#src/server/app-notifications/presence-expiry.server";
import {
  getPresenceObserver,
  type PresenceObserver,
} from "#src/server/app-notifications/presence-observer";

const ACTIVE_TTL_SECONDS = "90";
export const AGENT_STATUS_LEASE_MS = Number(ACTIVE_TTL_SECONDS) * 1_000;

export type AgentStatusScope = Pick<AgentStatus, "workspaceId" | "computerId" | "agentId">;
export type OrderedAgentStatus = Pick<
  AgentStatus,
  "status" | "daemonInstanceId" | "clientSeq" | "observedAtMs"
>;
export type AgentStatusSnapshot = OrderedAgentStatus & {
  expiresAt: number | null;
};

const SNAPSHOT_AGENT_STATUSES = `
local out = {}
for index = 1, #KEYS do
  local raw = redis.call("GET", KEYS[index])
  local remaining = redis.call("TTL", KEYS[index])
  -- A missing value is sent as an empty string: a Lua table cannot carry a nil hole through to
  -- the client, and an empty payload is what \`parse\` already treats as "no record".
  out[#out + 1] = raw or ""
  out[#out + 1] = remaining
end
return out
`;

/** The ordering rule of a put, shared by both write scripts: `reject` is what a script returns
 * for a status that is not newer than the one stored. */
const ORDERED_BY_INSTANCE_AND_SEQ = (reject: string) => `
local raw = redis.call("GET", KEYS[1])
if raw then
  local decoded, current = pcall(cjson.decode, raw)
  if decoded and type(current) == "table" then
    local same_instance = current.daemonInstanceId == ARGV[2]
    local accepted = false
    if same_instance then
      local current_seq = tonumber(current.clientSeq)
      local next_seq = tonumber(ARGV[3])
      accepted = current_seq and (
        next_seq > current_seq or
        (next_seq == current_seq and current.status == ARGV[5] and
          tonumber(current.observedAtMs) == tonumber(ARGV[4]))
      )
    else
      accepted = tonumber(current.observedAtMs) and
        tonumber(ARGV[4]) > tonumber(current.observedAtMs)
    end
    if not accepted then ${reject} end
  end
end
`;

const PUT_AGENT_STATUS = `${ORDERED_BY_INSTANCE_AND_SEQ("return 0")}redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[6])
return 1
`;

/**
 * The write while app notifications are in use: the same ordering and the same SET, and in the
 * same script the previous status goes back to the caller and the expiry index (KEYS[2], see
 * `presence-expiry.server.ts`) follows the status: an active Agent is filed under the millisecond
 * its lease ends, any other is removed. Returns `{accepted, previous}`, the previous status
 * being `inactive` when there was none.
 */
const PUT_AGENT_STATUS_TRACKED = `
local previous = "inactive"
local before = redis.call("GET", KEYS[1])
if before then
  local decoded, stored = pcall(cjson.decode, before)
  if decoded and type(stored) == "table" and stored.status == "active" then previous = "active" end
end
${ORDERED_BY_INSTANCE_AND_SEQ('return {0, ""}')}${REDIS_NOW_MS_LUA}redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[6])
if ARGV[5] == "active" then
  redis.call("ZADD", KEYS[2], now_ms + tonumber(ARGV[6]) * 1000, KEYS[1])
else
  redis.call("ZREM", KEYS[2], KEYS[1])
end
return {1, previous}
`;

export interface AgentStatusCache {
  put(status: AgentStatusScope & OrderedAgentStatus): Promise<boolean>;
  get(scope: AgentStatusScope): Promise<AgentStatus["status"]>;
  snapshot(scope: AgentStatusScope, now?: number): Promise<AgentStatusSnapshot | undefined>;
  /** Many snapshots in one round trip (a Workspace's Agent list); `undefined` per scope that has
   * no live lease, exactly like `snapshot`. Results come back in the scopes' order. */
  snapshotMany(
    scopes: readonly AgentStatusScope[],
    now?: number,
  ): Promise<Array<AgentStatusSnapshot | undefined>>;
}

export class RedisAgentStatusCache implements AgentStatusCache {
  constructor(
    private readonly redis: {
      eval(
        script: string,
        numberOfKeys: number,
        ...keysAndArgs: Array<string | number>
      ): Promise<unknown>;
      get(key: string): Promise<string | null>;
      ttl(key: string): Promise<number>;
    },
    /** `presence` (default: the process's `getPresenceObserver()`) is told of each change of
     * status while app notifications are in use (`enabled()`); otherwise a put is the one script
     * it always was. */
    private readonly options: {
      presence?: PresenceObserver;
      expiryKey?: string;
      ttlSeconds?: string;
    } = {},
  ) {}

  async put(status: AgentStatusScope & OrderedAgentStatus): Promise<boolean> {
    const presence = this.options.presence ?? getPresenceObserver();
    if (presence.enabled()) return this.putTracked(status, presence);
    const key = this.key(status);
    const record: OrderedAgentStatus = {
      status: status.status,
      daemonInstanceId: status.daemonInstanceId,
      clientSeq: status.clientSeq,
      observedAtMs: status.observedAtMs,
    };
    const accepted = await this.redis.eval(
      PUT_AGENT_STATUS,
      1,
      key,
      JSON.stringify(record),
      status.daemonInstanceId,
      status.clientSeq,
      status.observedAtMs,
      status.status,
      this.options.ttlSeconds ?? ACTIVE_TTL_SECONDS,
    );
    return accepted === 1;
  }

  private async putTracked(
    status: AgentStatusScope & OrderedAgentStatus,
    presence: PresenceObserver,
  ): Promise<boolean> {
    const result = await this.redis.eval(
      PUT_AGENT_STATUS_TRACKED,
      2,
      this.key(status),
      this.options.expiryKey ?? PRESENCE_EXPIRY_KEY,
      JSON.stringify({
        status: status.status,
        daemonInstanceId: status.daemonInstanceId,
        clientSeq: status.clientSeq,
        observedAtMs: status.observedAtMs,
      } satisfies OrderedAgentStatus),
      status.daemonInstanceId,
      status.clientSeq,
      status.observedAtMs,
      status.status,
      this.options.ttlSeconds ?? ACTIVE_TTL_SECONDS,
    );
    if (!Array.isArray(result) || result[0] !== 1) return false;
    const from = result[1] === "active" ? "active" : "inactive";
    if (from !== status.status)
      presence.agentStatus({
        workspaceId: status.workspaceId,
        agentId: status.agentId,
        from,
        to: status.status,
        observedAtMs: status.observedAtMs,
        idSeed: `${status.workspaceId}:${status.agentId}:status:${status.clientSeq}:${status.daemonInstanceId}:${status.status}`,
      });
    return true;
  }

  async get(scope: AgentStatusScope): Promise<AgentStatus["status"]> {
    return this.parse(await this.redis.get(this.key(scope)))?.status ?? "inactive";
  }

  async snapshot(scope: AgentStatusScope, now = Date.now()) {
    return (await this.snapshotMany([scope], now))[0];
  }

  async snapshotMany(scopes: readonly AgentStatusScope[], now = Date.now()) {
    if (scopes.length === 0) return [];
    const keys = scopes.map((scope) => this.key(scope));
    const flat = (await this.redis.eval(SNAPSHOT_AGENT_STATUSES, keys.length, ...keys)) as Array<
      string | number | null
    >;
    return scopes.map((_scope, index) => {
      const raw = flat[index * 2];
      const remainingSeconds = Number(flat[index * 2 + 1] ?? 0);
      const record = this.parse(typeof raw === "string" && raw.length > 0 ? raw : null);
      // Same rule as `snapshot`: a record without a live lease is not a snapshot at all.
      if (!record || remainingSeconds <= 0) return undefined;
      return {
        ...record,
        expiresAt: record.status === "active" ? now + remainingSeconds * 1_000 : null,
      };
    });
  }

  private parse(value: string | null): OrderedAgentStatus | undefined {
    if (!value) return undefined;
    try {
      const parsed: unknown = JSON.parse(value);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
      const status = Reflect.get(parsed, "status");
      const daemonInstanceId = Reflect.get(parsed, "daemonInstanceId");
      const clientSeq = Reflect.get(parsed, "clientSeq");
      const observedAtMs = Reflect.get(parsed, "observedAtMs");
      if (
        (status !== "active" && status !== "inactive") ||
        typeof daemonInstanceId !== "string" ||
        !daemonInstanceId ||
        !Number.isSafeInteger(clientSeq) ||
        clientSeq < 1 ||
        !Number.isSafeInteger(observedAtMs) ||
        observedAtMs < 1
      )
        return undefined;
      return { status, daemonInstanceId, clientSeq, observedAtMs };
    } catch {
      return undefined;
    }
  }

  private key(scope: AgentStatusScope): string {
    return workspaceRedisKey({
      workspaceId: scope.workspaceId,
      computerId: scope.computerId,
      agentId: scope.agentId,
      name: "status",
      version: "v2",
    });
  }
}

let singleton: RedisAgentStatusCache | undefined;

export function getAgentStatusCache(): AgentStatusCache {
  const redisUrl = redisUrlFor("Agent status");
  singleton ??= new RedisAgentStatusCache(openRedisClient(redisUrl));
  return singleton;
}
