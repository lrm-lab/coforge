import { getAgentUsageCapabilityLease } from "#src/server/computers/agent-usage-capability.server";
import type { RedisComputerCapabilityLease } from "#src/server/computers/computer-capability-lease.server";
import { openRedisClient } from "#src/server/redis-client.server";
import { workspaceRedisKey } from "#src/server/redis-keys.server";
import { redisUrlFor } from "#src/server/redis-url.server";
import { SCAN_RESULT_TTL_SECONDS, scanResultKeys } from "./scan-result-cache.server";
import {
  FAILED_USAGE_STALE_AFTER_MS,
  USAGE_STALE_AFTER_MS,
  type UsageCacheKey,
  type UsageReadResult,
  type UsageResultRecord,
} from "./usage-cache.server";

export type AgentUsageCacheScope = UsageCacheKey & {
  agentId: string;
  runtimeConfigRevision: number;
  workerInstanceId: string;
};

const AGENT_USAGE_SCAN_TTL_SECONDS = "20";

const REQUIRE_CURRENT_WORKER = `
local value = redis.call("GET", KEYS[1])
if not value then return nil end
local ok, lease = pcall(cjson.decode, value)
if not ok or type(lease) ~= "table" or lease.state ~= "supported" or lease.workerInstanceId ~= ARGV[1] then
  return nil
end
`;

const CLAIM = `${REQUIRE_CURRENT_WORKER}
local scan = redis.call("GET", KEYS[2])
if scan then return scan end
redis.call("SET", KEYS[2], ARGV[2], "EX", ARGV[3])
return ARGV[2]`;

const COMPLETE = `${REQUIRE_CURRENT_WORKER}
if redis.call("GET", KEYS[2]) ~= ARGV[2] then return nil end
redis.call("SET", KEYS[3], ARGV[3], "EX", ARGV[4])
redis.call("DEL", KEYS[2])
return 1`;

const READ = `${REQUIRE_CURRENT_WORKER}
return redis.call("MGET", KEYS[2], KEYS[3])`;

const RELEASE = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0`;

export class RedisAgentUsageCache {
  constructor(
    private readonly redis: { send(command: "EVAL", args: string[]): Promise<unknown> },
    private readonly lease: Pick<RedisComputerCapabilityLease, "key">,
    private readonly now = Date.now,
  ) {}

  async claim(scope: AgentUsageCacheScope, scanId: string): Promise<string | undefined> {
    const { lease, scan } = this.keys(scope);
    const result = await this.redis.send("EVAL", [
      CLAIM,
      "2",
      lease,
      scan,
      scope.workerInstanceId,
      scanId,
      AGENT_USAGE_SCAN_TTL_SECONDS,
    ]);
    return typeof result === "string" ? result : undefined;
  }

  async release(scope: AgentUsageCacheScope, scanId: string): Promise<void> {
    await this.redis.send("EVAL", [RELEASE, "1", this.keys(scope).scan, scanId]);
  }

  async complete(scope: AgentUsageCacheScope, reading: UsageResultRecord): Promise<boolean> {
    const { lease, scan, result } = this.keys(scope);
    return (
      (await this.redis.send("EVAL", [
        COMPLETE,
        "3",
        lease,
        scan,
        result,
        scope.workerInstanceId,
        reading.scanId,
        JSON.stringify(reading),
        SCAN_RESULT_TTL_SECONDS,
      ])) === 1
    );
  }

  async read(scope: AgentUsageCacheScope): Promise<UsageReadResult | undefined> {
    const { lease, scan, result } = this.keys(scope);
    const items = await this.redis.send("EVAL", [
      READ,
      "3",
      lease,
      scan,
      result,
      scope.workerInstanceId,
    ]);
    if (!Array.isArray(items)) return undefined;
    const [pending, cached] = items;
    const pendingScanId = typeof pending === "string" ? pending : undefined;
    if (typeof cached !== "string") return { state: "missing", pendingScanId };
    const reading = JSON.parse(cached) as UsageResultRecord;
    const age = this.now() - Date.parse(reading.lastAttemptAt ?? reading.collectedAt);
    const staleAfter =
      reading.status === "available" ? USAGE_STALE_AFTER_MS : FAILED_USAGE_STALE_AFTER_MS;
    return { state: age <= staleAfter ? "fresh" : "stale", result: reading, pendingScanId };
  }

  private keys(scope: AgentUsageCacheScope) {
    const key = workspaceRedisKey({
      workspaceId: scope.workspaceId,
      computerId: scope.computerId,
      agentId: scope.agentId,
      name: "agent-usage",
      version: "v1",
    });
    return {
      ...scanResultKeys(
        `${key}:${scope.provider}:${scope.runtimeConfigRevision}:${encodeURIComponent(scope.workerInstanceId)}`,
      ),
      lease: this.lease.key(scope.workspaceId, scope.computerId),
    };
  }
}

let cache: RedisAgentUsageCache | undefined;

export function getAgentUsageCache() {
  return (cache ??= new RedisAgentUsageCache(
    openRedisClient(redisUrlFor("Agent usage cache")),
    getAgentUsageCapabilityLease(),
  ));
}
