import { openRedisClient } from "#src/server/redis-client.server";
import {
  NO_RATE_LIMIT,
  RateLimitOutageLog,
  RedisAppRateLimit,
  type AppRateLimit,
} from "./app-rate-limit.server";

const WINDOW_MS = 60_000;
/** Requests a minute per app (client) for its `client_credentials` token requests (a token lives
 * ten minutes). The docs state this number: change them together. */
export const APP_TOKEN_LIMIT_PER_MINUTE = 30;
/** Reads a minute per installation across the four endpoints. The docs state this number too. */
export const APP_INSTALLATION_LIMIT_PER_MINUTE = 120;

export type AppRateLimits = { token: AppRateLimit; installation: AppRateLimit };

let limits: AppRateLimits | undefined;

/** The two limits over the web server's Redis (`REDIS_URL`), built once. Without a `REDIS_URL` this
 * deployment counts nothing, the same as when Redis is down, and says so once at first use. */
export function getAppRateLimits(): AppRateLimits {
  limits ??= createAppRateLimits(Bun.env.REDIS_URL);
  return limits;
}

/** Forgets the memoized limits, so the next use rebuilds them. */
export function resetAppRateLimits() {
  limits = undefined;
}

function createAppRateLimits(redisUrl: string | undefined): AppRateLimits {
  const outageLog = new RateLimitOutageLog();
  if (!redisUrl) return unconfiguredLimits(outageLog);
  const redis = openRedisClient(redisUrl);
  return {
    token: new RedisAppRateLimit(redis, {
      keyPrefix: "coforge:ratelimit:app-token:v1",
      limit: APP_TOKEN_LIMIT_PER_MINUTE,
      windowMs: WINDOW_MS,
      outageLog,
    }),
    installation: new RedisAppRateLimit(redis, {
      keyPrefix: "coforge:ratelimit:app-installation:v1",
      limit: APP_INSTALLATION_LIMIT_PER_MINUTE,
      windowMs: WINDOW_MS,
      outageLog,
    }),
  };
}

function unconfiguredLimits(outageLog: RateLimitOutageLog): AppRateLimits {
  let reported = false;
  const limit: AppRateLimit = {
    async admit(id) {
      if (!reported) {
        reported = true;
        outageLog.report("app-rate-limits", new Error("REDIS_URL is not set"));
      }
      return NO_RATE_LIMIT.admit(id);
    },
  };
  return { token: limit, installation: limit };
}
