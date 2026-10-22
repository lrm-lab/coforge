/**
 * A fixed-window request counter in Redis, for the third-party app surface.
 *
 * `rate-limiter-flexible` (ISC, 11.2.3) was tried first and not adopted: its Redis store drives
 * ioredis- or node-redis-shaped clients (`multi()`, `eval(script, {keys, arguments})`,
 * `defineCommand`), and Bun's `RedisClient` has none of those shapes. Only `consume` worked, behind
 * a hand-written `eval` shim; `get` needs `multi()`. The shim would be as long as this counter and
 * would pin the library's private client contract, so the counter is written directly.
 */

/** The one Redis command the counter uses; `RedisClient.send` satisfies it. */
export interface RateLimitRedis {
  send(command: string, args: string[]): Promise<unknown>;
}

export type RateLimitDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/** Admits or refuses one request from `id` (a client or an installation). */
export interface AppRateLimit {
  admit(id: string): Promise<RateLimitDecision>;
}

export const NO_RATE_LIMIT: AppRateLimit = { admit: async () => ({ allowed: true }) };

/** Count, and start the window on the first request, in one atomic step. Answers {count, ttl ms}. */
const COUNT_IN_WINDOW = `
local count = redis.call("INCR", KEYS[1])
local ttl = redis.call("PTTL", KEYS[1])
if count == 1 or ttl < 0 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}`;

const UNAVAILABLE_LOG_INTERVAL_MS = 60_000;

/**
 * Logs `app_rate_limit:redis_unavailable` at most once a minute. The limiters of one process share
 * one, so the throttle holds across all of them.
 */
export class RateLimitOutageLog {
  private lastLogged = Number.NEGATIVE_INFINITY;

  constructor(private readonly now: () => number = Date.now) {}

  report(keyPrefix: string, error: unknown) {
    const now = this.now();
    if (now - this.lastLogged < UNAVAILABLE_LOG_INTERVAL_MS) return;
    this.lastLogged = now;
    console.warn(
      JSON.stringify({
        event: "app_rate_limit:redis_unavailable",
        key_prefix: keyPrefix,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

/** What the counter script answers: the count and the milliseconds left in the window. */
function windowOf(reply: unknown): { count: number; ttlMs: number } {
  if (
    Array.isArray(reply) &&
    reply.length === 2 &&
    reply.every((value) => typeof value === "number" && Number.isFinite(value))
  )
    return { count: reply[0] as number, ttlMs: reply[1] as number };
  throw new Error(`unexpected reply from the rate-limit script: ${JSON.stringify(reply)}`);
}

/**
 * `limit` requests per `windowMs` for each id, counted under `<keyPrefix>:<id>`. A window starts at
 * an id's first request and ends `windowMs` later, so a burst straddling two windows can reach
 * twice the limit; that is the price of one INCR per request.
 *
 * Fails open: when Redis cannot be reached, or answers something other than the script's reply, the
 * request is admitted, because a counter outage must not take the apps' token and data endpoints
 * down with it (every one of them is already authenticated). The outage goes to `outageLog`.
 */
export class RedisAppRateLimit implements AppRateLimit {
  constructor(
    private readonly redis: RateLimitRedis,
    private readonly options: {
      keyPrefix: string;
      limit: number;
      windowMs: number;
      outageLog: RateLimitOutageLog;
    },
  ) {}

  async admit(id: string): Promise<RateLimitDecision> {
    const { keyPrefix, limit, windowMs, outageLog } = this.options;
    try {
      const { count, ttlMs } = windowOf(
        await this.redis.send("EVAL", [
          COUNT_IN_WINDOW,
          "1",
          `${keyPrefix}:${encodeURIComponent(id)}`,
          String(windowMs),
        ]),
      );
      if (count <= limit) return { allowed: true };
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(ttlMs / 1000)) };
    } catch (error) {
      outageLog.report(keyPrefix, error);
      return { allowed: true };
    }
  }
}
