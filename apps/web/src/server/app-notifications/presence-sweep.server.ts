import { appNotificationPresence } from "./app-notification-presence.server";
import {
  PRESENCE_EXPIRY_KEY,
  REDIS_NOW_MS_LUA,
  parsePresenceMember,
} from "./presence-expiry.server";
import type { PresenceObserver } from "./presence-observer";
import { appNotificationsPossible } from "./app-notifications.server";
import { openRedisClient } from "#src/server/redis-client.server";
import { redisUrlFor } from "#src/server/redis-url.server";
import { onServerShutdown } from "#src/server/runtime/server-lifecycle.server";
import { errorType } from "#src/server/errors/error-type.server";

/** The same cadence as the Agent activity sweep. */
export const PRESENCE_SWEEP_INTERVAL_MS = 5_000;
/** Bounds one tick's Redis and queue cost regardless of fleet size. */
const SWEEP_BATCH_LIMIT = 200;
/** Shorter than the interval on purpose, so a slow tick cannot overlap the next one. */
const SWEEP_LOCK_TTL_MS = 4_500;
const SWEEP_LOCK_KEY = "coforge:presence:expiry-sweep:lock";
/** Redis's clock and the members due by it, with their scores: `{now_ms, member, score, ...}`,
 * ZRANGEBYSCORE ≤ now, oldest first, at most the limit. The web instance's clock is never used:
 * the scores are Redis's, so are "now" and the key's own lease. */
const DUE_MEMBERS = `${REDIS_NOW_MS_LUA}local out = {now_ms}
local due = redis.call("ZRANGEBYSCORE", KEYS[1], "-inf", now_ms, "WITHSCORES", "LIMIT", 0, ARGV[1])
for i = 1, #due do out[#out + 1] = due[i] end
return out
`;

/** Claims one member for this caller alone. A status key that exists again (refreshed after the
 * lapse, or written by a path that does not file it) is not claimed: its score moves to the key's
 * real end (PTTL), so it neither emits nor starves the batch as a due member forever (a key with
 * no expiry is dropped from the index). Of two callers racing for a gone key only the one whose
 * ZREM removes the member gets 1. */
const CLAIM_MEMBER = `${REDIS_NOW_MS_LUA}if redis.call("EXISTS", KEYS[1]) == 1 then
  local pttl = redis.call("PTTL", KEYS[1])
  if pttl > 0 then
    redis.call("ZADD", KEYS[2], now_ms + pttl, KEYS[1])
  else
    redis.call("ZREM", KEYS[2], KEYS[1])
  end
  return 0
end
return redis.call("ZREM", KEYS[2], KEYS[1])
`;

export interface PresenceSweepRedis {
  eval(script: string, keys: number, ...args: Array<string | number>): Promise<unknown>;
}

export interface PresenceSweepLock {
  acquire(instanceId: string): Promise<boolean>;
}

export class RedisPresenceSweepLock implements PresenceSweepLock {
  constructor(
    private readonly redis: {
      set(key: string, value: string, ...options: Array<string | number>): Promise<unknown>;
    },
  ) {}

  async acquire(instanceId: string): Promise<boolean> {
    return (
      (await this.redis.set(SWEEP_LOCK_KEY, instanceId, "NX", "PX", SWEEP_LOCK_TTL_MS)) === "OK"
    );
  }
}

/**
 * Presence events for leases that lapse without a word: Redis tells nobody when a status key
 * expires, so the index `presence-expiry.server.ts` describes names the keys to look at. Every
 * tick one web instance (the lock) claims the members whose time has passed and whose key is gone,
 * and reports each as an Agent going `active` to `inactive` or a Computer going `offline`, at the
 * time the lease ended, however late (after an outage the offline and inactive events arrive late
 * but paired with their online and active ones). While `possible()` is false a tick does nothing.
 * Like `AgentActivitySweep` it never rejects, and construction does not start the loop.
 */
export class PresenceSweep {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  private readonly redis: PresenceSweepRedis;
  private readonly lock: PresenceSweepLock;
  private readonly observer: PresenceObserver;
  private readonly instanceId: string;
  private readonly expiryKey: string;
  private readonly batchLimit: number;
  private readonly possible: () => boolean;

  constructor(options: {
    redis: PresenceSweepRedis;
    lock: PresenceSweepLock;
    observer: PresenceObserver;
    /** The one source for "can any event be sent": a tick does nothing while it is false. */
    possible: () => boolean;
    instanceId?: string;
    expiryKey?: string;
    batchLimit?: number;
  }) {
    this.redis = options.redis;
    this.lock = options.lock;
    this.observer = options.observer;
    this.instanceId = options.instanceId ?? crypto.randomUUID();
    this.expiryKey = options.expiryKey ?? PRESENCE_EXPIRY_KEY;
    this.batchLimit = options.batchLimit ?? SWEEP_BATCH_LIMIT;
    this.possible = options.possible;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), PRESENCE_SWEEP_INTERVAL_MS);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.ticking || !this.possible()) return;
    this.ticking = true;
    try {
      if (!(await this.lock.acquire(this.instanceId))) return;
      const due = (await this.redis.eval(
        DUE_MEMBERS,
        1,
        this.expiryKey,
        this.batchLimit,
      )) as unknown[];
      for (let index = 1; index + 1 < due.length; index += 2)
        await this.sweepOne(String(due[index]), Number(due[index + 1]));
    } catch (error) {
      console.error(
        JSON.stringify({ event: "presence_sweep.tick_failed", error_type: errorType(error) }),
      );
    } finally {
      this.ticking = false;
    }
  }

  private async sweepOne(member: string, expiredAtMs: number): Promise<void> {
    const claimed = await this.redis.eval(CLAIM_MEMBER, 2, member, this.expiryKey);
    if (claimed !== 1) return;
    const scope = parsePresenceMember(member);
    if (!scope) return;
    const idSeed = `${member}:expired:${expiredAtMs}`;
    if (scope.kind === "agent")
      this.observer.agentStatus({
        workspaceId: scope.workspaceId,
        agentId: scope.agentId,
        from: "active",
        to: "inactive",
        observedAtMs: expiredAtMs,
        idSeed,
      });
    else
      this.observer.computerPresence({
        workspaceId: scope.workspaceId,
        computerId: scope.computerId,
        from: "online",
        to: "offline",
        observedAtMs: expiredAtMs,
        idSeed,
      });
  }
}

let singleton: PresenceSweep | undefined;
let stopRegistered = false;

/**
 * Idempotent per process; called by the Centrifugo RPC composition next to the Agent activity
 * sweep. Inert while `appNotificationsPossible()` is false (a tick returns before any Redis
 * call), so a deployment without app notifications pays for a timer and nothing else.
 */
export function ensurePresenceSweep(): PresenceSweep {
  if (!singleton) {
    // Opened at the first tick that runs, so a deployment that never turns the feature on opens no
    // connection, and one that turns it on with a flag file reload gets it then.
    let client: ReturnType<typeof openRedisClient> | undefined;
    const redis = () => (client ??= openRedisClient(redisUrlFor("the presence sweep")));
    singleton = new PresenceSweep({
      redis: { eval: (script, keys, ...args) => redis().eval(script, keys, ...args) },
      lock: { acquire: (instanceId) => new RedisPresenceSweepLock(redis()).acquire(instanceId) },
      observer: appNotificationPresence,
      possible: appNotificationsPossible,
    });
  }
  if (!stopRegistered) {
    stopRegistered = true;
    const sweep = singleton;
    onServerShutdown(() => sweep.stop());
  }
  singleton.start();
  return singleton;
}
