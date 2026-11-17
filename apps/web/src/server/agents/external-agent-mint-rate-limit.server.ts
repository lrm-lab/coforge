import {
  NO_PEEKABLE_RATE_LIMIT,
  RateLimitOutageLog,
  RedisAppRateLimit,
  type PeekableRateLimit,
} from "#src/server/app-rate-limits/app-rate-limit.server";
import { openRedisClient } from "#src/server/redis-client.server";

export const EXTERNAL_MINT_WINDOW_MS = 10 * 60_000;
export const EXTERNAL_MINT_PERSON_LIMIT = 30;
export const EXTERNAL_MINT_AGENT_LIMIT = 20;
export const EXTERNAL_MINT_REFUSAL = "agent_credential_mint_rate_limited";

export type ExternalMintRateLimits = { person: PeekableRateLimit; agent: PeekableRateLimit };

export type ExternalMintWho = { userId: string | null; agentId?: string | undefined };

export type ExternalMintAdmission =
  | { allowed: true }
  | { allowed: false; limit: "person" | "agent"; retryAfterSeconds: number };

export const NO_EXTERNAL_MINT_RATE_LIMITS: ExternalMintRateLimits = {
  person: NO_PEEKABLE_RATE_LIMIT,
  agent: NO_PEEKABLE_RATE_LIMIT,
};

async function check(
  limits: ExternalMintRateLimits,
  who: ExternalMintWho,
  how: "admit" | "peek",
): Promise<ExternalMintAdmission> {
  if (who.agentId !== undefined) {
    const byAgent = await limits.agent[how](who.agentId);
    if (!byAgent.allowed)
      return { allowed: false, limit: "agent", retryAfterSeconds: byAgent.retryAfterSeconds };
  }
  if (who.userId !== null) {
    const byPerson = await limits.person[how](who.userId);
    if (!byPerson.allowed)
      return { allowed: false, limit: "person", retryAfterSeconds: byPerson.retryAfterSeconds };
  }
  return { allowed: true };
}

export function admitExternalMint(limits: ExternalMintRateLimits, who: ExternalMintWho) {
  return check(limits, who, "admit");
}

export function peekExternalMint(limits: ExternalMintRateLimits, who: ExternalMintWho) {
  return check(limits, who, "peek");
}

let limits: ExternalMintRateLimits | undefined;

export function getExternalMintRateLimits(): ExternalMintRateLimits {
  limits ??= createExternalMintRateLimits(Bun.env.REDIS_URL);
  return limits;
}

function createExternalMintRateLimits(redisUrl: string | undefined): ExternalMintRateLimits {
  const outageLog = new RateLimitOutageLog();
  if (!redisUrl) {
    outageLog.report("external-agent-mint", new Error("REDIS_URL is not set"));
    return NO_EXTERNAL_MINT_RATE_LIMITS;
  }
  const redis = openRedisClient(redisUrl);
  const limit = (keyPrefix: string, max: number) =>
    new RedisAppRateLimit(redis, {
      keyPrefix,
      limit: max,
      windowMs: EXTERNAL_MINT_WINDOW_MS,
      outageLog,
    });
  return {
    person: limit("coforge:ratelimit:external-mint-person:v1", EXTERNAL_MINT_PERSON_LIMIT),
    agent: limit("coforge:ratelimit:external-mint-agent:v1", EXTERNAL_MINT_AGENT_LIMIT),
  };
}
