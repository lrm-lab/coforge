import { openRedisClient } from "#src/server/redis-client.server";
import {
  NO_PEEKABLE_RATE_LIMIT,
  NO_RATE_LIMIT,
  RateLimitOutageLog,
  RedisAppRateLimit,
  type AppRateLimit,
  type PeekableRateLimit,
} from "./app-rate-limit.server";

const WINDOW_MS = 60_000;
/** Requests a minute per app (client) for its `client_credentials` token requests (a token lives
 * ten minutes). The docs state this number: change them together. */
export const APP_TOKEN_LIMIT_PER_MINUTE = 30;
/** Reads a minute per installation across the four endpoints. The docs state this number too. */
export const APP_INSTALLATION_LIMIT_PER_MINUTE = 120;
/** Public artifact page loads (the wrapper and its frames) a minute per client IP. */
export const PUBLIC_ARTIFACT_LIMIT_PER_MINUTE = 120;
/** The other files of public artifact pages (styles, scripts, images, fonts) a minute per client
 * IP: a page may be up to 200 files, and a reader opens several. */
export const PUBLIC_ARTIFACT_FILE_LIMIT_PER_MINUTE = 2000;
/** Misses a minute per client IP on a link-tier artifact's address (no such artifact, or not shared
 * by link): one refusal for both, so a miss tells nothing. */
export const PUBLIC_ARTIFACT_MISS_LIMIT_PER_MINUTE = 20;
/** Misses a minute across every client past which a warning is logged; nothing is refused. */
export const PUBLIC_ARTIFACT_MISS_GLOBAL_WARN_PER_MINUTE = 300;
export const ARTIFACT_AGENT_WRITE_LIMIT_PER_MINUTE = 60;
export const ARTIFACT_ZIP_LIMIT_PER_MINUTE = 10;
/** Comment posts, comment image uploads and will-notify previews a minute per person. */
export const ARTIFACT_PERSON_COMMENT_LIMIT_PER_MINUTE = 120;

export type AppRateLimits = {
  token: AppRateLimit;
  installation: AppRateLimit;
  publicArtifact: AppRateLimit;
  publicArtifactFile: AppRateLimit;
  publicArtifactMiss: PeekableRateLimit;
  publicArtifactMissGlobal: AppRateLimit;
  artifactWrite: AppRateLimit;
  artifactZip: AppRateLimit;
  artifactPersonComment: AppRateLimit;
};

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
    publicArtifact: new RedisAppRateLimit(redis, {
      keyPrefix: "coforge:ratelimit:public-artifact:v1",
      limit: PUBLIC_ARTIFACT_LIMIT_PER_MINUTE,
      windowMs: WINDOW_MS,
      outageLog,
    }),
    publicArtifactFile: new RedisAppRateLimit(redis, {
      keyPrefix: "coforge:ratelimit:public-artifact-file:v1",
      limit: PUBLIC_ARTIFACT_FILE_LIMIT_PER_MINUTE,
      windowMs: WINDOW_MS,
      outageLog,
    }),
    publicArtifactMiss: new RedisAppRateLimit(redis, {
      keyPrefix: "coforge:ratelimit:public-artifact-miss:v1",
      limit: PUBLIC_ARTIFACT_MISS_LIMIT_PER_MINUTE,
      windowMs: WINDOW_MS,
      outageLog,
    }),
    publicArtifactMissGlobal: new RedisAppRateLimit(redis, {
      keyPrefix: "coforge:ratelimit:public-artifact-miss-global:v1",
      limit: PUBLIC_ARTIFACT_MISS_GLOBAL_WARN_PER_MINUTE,
      windowMs: WINDOW_MS,
      outageLog,
    }),
    artifactWrite: new RedisAppRateLimit(redis, {
      keyPrefix: "coforge:ratelimit:artifact-write:v1",
      limit: ARTIFACT_AGENT_WRITE_LIMIT_PER_MINUTE,
      windowMs: WINDOW_MS,
      outageLog,
    }),
    artifactZip: new RedisAppRateLimit(redis, {
      keyPrefix: "coforge:ratelimit:artifact-zip:v1",
      limit: ARTIFACT_ZIP_LIMIT_PER_MINUTE,
      windowMs: WINDOW_MS,
      outageLog,
    }),
    artifactPersonComment: new RedisAppRateLimit(redis, {
      keyPrefix: "coforge:ratelimit:artifact-person-comment:v1",
      limit: ARTIFACT_PERSON_COMMENT_LIMIT_PER_MINUTE,
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
  return {
    token: limit,
    installation: limit,
    publicArtifact: limit,
    publicArtifactFile: limit,
    publicArtifactMiss: NO_PEEKABLE_RATE_LIMIT,
    publicArtifactMissGlobal: limit,
    artifactWrite: limit,
    artifactZip: limit,
    artifactPersonComment: limit,
  };
}
