import { openRedisClient } from "#src/server/redis-client.server";
import { redisUrlFor } from "#src/server/redis-url.server";
import { workspaceRedisKey } from "#src/server/redis-keys.server";
import {
  PRESENCE_EXPIRY_KEY,
  PRESENCE_SEQ_TTL_SECONDS,
  REDIS_NOW_MS_LUA,
} from "#src/server/app-notifications/presence-expiry.server";
import {
  getPresenceObserver,
  type PresenceObserver,
} from "#src/server/app-notifications/presence-observer";

const COMPUTER_STATUS_TTL_SECONDS = "90";
export const COMPUTER_STATUS_LEASE_MS = Number(COMPUTER_STATUS_TTL_SECONDS) * 1_000;

/**
 * The write while app notifications are in use: the same SET, and in the same script the previous
 * value goes back to the caller (with Redis's clock, which dates the transition and the lease's
 * end, and a per-Computer transition counter, KEYS[3], that makes the event id unique even for two
 * transitions in one millisecond) and the expiry index (KEYS[2], see `presence-expiry.server.ts`)
 * follows: an online Computer is filed under the millisecond its lease ends, an offline one is
 * removed.
 */
const PUT_COMPUTER_STATUS_TRACKED = `
local previous = redis.call("GET", KEYS[1]) or ""
${REDIS_NOW_MS_LUA}local seq = 0
if previous ~= ARGV[1] then
  seq = redis.call("INCR", KEYS[3])
  redis.call("EXPIRE", KEYS[3], ${PRESENCE_SEQ_TTL_SECONDS})
end
redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[2])
if ARGV[1] == "online" then
  redis.call("ZADD", KEYS[2], now_ms + tonumber(ARGV[2]) * 1000, KEYS[1])
else
  redis.call("ZREM", KEYS[2], KEYS[1])
end
return {previous, now_ms, seq}
`;

export type ComputerStatusScope = { workspaceId: string; computerId: string };

export interface ComputerStatusCache {
  put(scope: ComputerStatusScope, online: boolean): Promise<void>;
  get(scope: ComputerStatusScope): Promise<boolean>;
  /** One round trip for many Computers (the list page's shape); missing keys read as
   * offline, exactly like `get`. Returns statuses in the scopes' order. */
  getMany(scopes: readonly ComputerStatusScope[]): Promise<boolean[]>;
}

export class RedisComputerStatusCache implements ComputerStatusCache {
  constructor(
    private readonly redis: {
      set(key: string, value: string, ex: "EX", seconds: string): Promise<unknown>;
      get(key: string): Promise<string | null>;
      mget(...keys: string[]): Promise<Array<string | null>>;
    },
    private readonly ttlSeconds = COMPUTER_STATUS_TTL_SECONDS,
    /** While the observer is `enabled()` (app notifications in use) a put goes through `redis` as
     * one script and `presence` (default: the process's `getPresenceObserver()`) is told when the
     * Computer comes online or goes offline. */
    private readonly tracking?: {
      presence?: PresenceObserver;
      redis: {
        eval(script: string, keys: number, ...args: Array<string | number>): Promise<unknown>;
      };
      expiryKey?: string;
    },
  ) {}

  async put(scope: ComputerStatusScope, online: boolean) {
    const presence = this.tracking?.presence ?? getPresenceObserver();
    if (this.tracking && presence.enabled())
      return this.putTracked(this.tracking, presence, scope, online);
    await this.redis.set(this.key(scope), online ? "online" : "offline", "EX", this.ttlSeconds);
  }

  private async putTracked(
    tracking: NonNullable<typeof this.tracking>,
    presence: PresenceObserver,
    scope: ComputerStatusScope,
    online: boolean,
  ) {
    const key = this.key(scope);
    const result = await tracking.redis.eval(
      PUT_COMPUTER_STATUS_TRACKED,
      3,
      key,
      tracking.expiryKey ?? PRESENCE_EXPIRY_KEY,
      `${key}:presence-seq`,
      online ? "online" : "offline",
      this.ttlSeconds,
    );
    if (!Array.isArray(result)) return;
    const from = result[0] === "online" ? "online" : "offline";
    const to = online ? "online" : "offline";
    const observedAtMs = Number(result[1]);
    const seq = Number(result[2]);
    if (from !== to)
      presence.computerPresence({
        workspaceId: scope.workspaceId,
        computerId: scope.computerId,
        from,
        to,
        observedAtMs,
        idSeed: `${scope.workspaceId}:${scope.computerId}:${to}:${seq}:${observedAtMs}`,
      });
  }

  async get(scope: ComputerStatusScope) {
    return (await this.redis.get(this.key(scope))) === "online";
  }

  async getMany(scopes: readonly ComputerStatusScope[]) {
    if (scopes.length === 0) return [];
    const values = await this.redis.mget(...scopes.map((scope) => this.key(scope)));
    return values.map((value) => value === "online");
  }

  private key(scope: ComputerStatusScope) {
    return workspaceRedisKey({
      workspaceId: scope.workspaceId,
      computerId: scope.computerId,
      name: "status",
      version: "v1",
    });
  }
}

let singleton: RedisComputerStatusCache | undefined;

export function getComputerStatusCache() {
  if (!singleton) {
    const redis = openRedisClient(redisUrlFor("Computer status"));
    singleton = new RedisComputerStatusCache(redis, COMPUTER_STATUS_TTL_SECONDS, { redis });
  }
  return singleton;
}
