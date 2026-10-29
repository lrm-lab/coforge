import { createHash } from "node:crypto";

import {
  NO_RATE_LIMIT,
  RateLimitOutageLog,
  RedisAppRateLimit,
  type AppRateLimit,
} from "#src/server/app-rate-limits/app-rate-limit.server";
import { openRedisClient } from "#src/server/redis-client.server";

/**
 * The limits on sending verification codes, and on guessing a password-reset code. Signing in has
 * no attempt limit of its own: a lockout costs a person their account and an attacker nothing they
 * cannot spend elsewhere (Frank, 2026-10-29). Authing sees every call from this server's address,
 * so its own per-address limits would either never trip for an attacker or lock everyone out;
 * these are ours, checked before Authing is called. Every attempt counts, whatever its outcome.
 */
export const SIGN_IN_WINDOW_MS = 15 * 60_000;
/** Attempts per client address in a window (the address is the proxy's view of the client). */
export const SIGN_IN_ADDRESS_LIMIT = 20;
/**
 * Attempts per account (email or phone number) from one client address in a window. This is what
 * stops one client from guessing at an account. A password and a code sign-in for the same email
 * share it.
 */
export const SIGN_IN_ACCOUNT_ADDRESS_LIMIT = 10;
/**
 * Attempts per account in a window from all addresses together, which still stops a guess spread
 * over many addresses. It stays well above what one address can spend (`SIGN_IN_ACCOUNT_ADDRESS_LIMIT`,
 * and an address refused there is not counted here), so that no one address can use up an account's
 * attempts and lock its owner out.
 */
export const SIGN_IN_ACCOUNT_LIMIT = 50;

/** Codes sent cost money (SMS) and reach a third party, so their window is longer. */
export const CODE_SEND_WINDOW_MS = 60 * 60_000;
/** Codes asked for per client address in a window. */
export const CODE_SEND_ADDRESS_LIMIT = 20;
/**
 * Codes sent to one phone number or email in a window, from wherever they are asked for. A trade
 * between two costs: every code to a mainland number is an SMS we pay for, so fewer is cheaper, but
 * anyone can ask for codes to someone else's destination and so use this up, which keeps the owner
 * from receiving one (and from signing in or resetting a password by code) until the window ends,
 * so fewer is also easier to abuse. Ten an hour leaves a person room to retry a delayed or
 * mistyped code, and bounds an attacker's cost to us at ten SMS an hour per destination.
 */
export const CODE_SEND_DESTINATION_LIMIT = 10;

export type ResetCodeRateLimits = {
  address: AppRateLimit;
  /** Per account and client address together. */
  accountAddress: AppRateLimit;
  /** Per account, whatever the address. */
  account: AppRateLimit;
};
export type CodeSendRateLimits = { address: AppRateLimit; destination: AppRateLimit };

/** Which limit refused an attempt. */
export type SignInLimit = "address" | "account_address" | "account";
export type CodeSendLimit = "address" | "destination";

export type SignInAdmission = { allowed: true } | { allowed: false; limit: SignInLimit };
export type CodeSendAdmission = { allowed: true } | { allowed: false; limit: CodeSendLimit };

export const NO_RESET_CODE_RATE_LIMITS: ResetCodeRateLimits = {
  address: NO_RATE_LIMIT,
  accountAddress: NO_RATE_LIMIT,
  account: NO_RATE_LIMIT,
};

/** A phone number or an email as Redis counts it: the hash of its normalized form, so Redis never
 * holds it. */
function counted(normalized: string): string {
  return createHash("sha256").update(normalized).digest("hex");
}

/**
 * Admits or refuses one attempt to set a password with a code, checking from the narrowest limit
 * out: the address, then
 * the account from this address, then the account from everywhere. A refusal at one does not count
 * at the next, so a flood from one address is stopped at its own limits and cannot use up what
 * protects a victim from being locked out. Without an address only the account (from everywhere)
 * The account (an email, or a phone number as `codeDestinationKey` writes it) is counted by the
 * hash of its trimmed, lower-cased form, and the pair by the hash of both.
 */
export async function admitResetCodeAttempt(
  limits: ResetCodeRateLimits,
  attempt: { account?: string | undefined; clientAddress?: string | undefined },
): Promise<SignInAdmission> {
  const { clientAddress } = attempt;
  if (clientAddress !== undefined) {
    const byAddress = await limits.address.admit(clientAddress);
    if (!byAddress.allowed) return { allowed: false, limit: "address" };
  }
  if (attempt.account === undefined) return { allowed: true };
  const account = attempt.account.trim().toLowerCase();
  if (clientAddress !== undefined) {
    const byPair = await limits.accountAddress.admit(counted(`${account}\n${clientAddress}`));
    if (!byPair.allowed) return { allowed: false, limit: "account_address" };
  }
  const byAccount = await limits.account.admit(counted(account));
  return byAccount.allowed ? { allowed: true } : { allowed: false, limit: "account" };
}

/**
 * Admits or refuses one request to send a verification code, the same way: the address first,
 * whose refusal does not count against the destination, then the destination (`destination` is
 * `codeDestinationKey`'s normalized form).
 */
export async function admitCodeSend(
  limits: CodeSendRateLimits,
  request: { destination: string; clientAddress?: string | undefined },
): Promise<CodeSendAdmission> {
  if (request.clientAddress !== undefined) {
    const byAddress = await limits.address.admit(request.clientAddress);
    if (!byAddress.allowed) return { allowed: false, limit: "address" };
  }
  const byDestination = await limits.destination.admit(counted(request.destination));
  return byDestination.allowed ? { allowed: true } : { allowed: false, limit: "destination" };
}

type AllLimits = { signIn: ResetCodeRateLimits; codeSend: CodeSendRateLimits };

let limits: AllLimits | undefined;

function allLimits(): AllLimits {
  limits ??= createRateLimits(Bun.env.REDIS_URL);
  return limits;
}

/** The sign-in limits over the web server's Redis (`REDIS_URL`), built once. Without a `REDIS_URL`
 * nothing is counted, the same as when Redis is down, and the outage log says so once. */
export function getResetCodeRateLimits(): ResetCodeRateLimits {
  return allLimits().signIn;
}

/** The limits on sending codes, over the same Redis. */
export function getCodeSendRateLimits(): CodeSendRateLimits {
  return allLimits().codeSend;
}

function createRateLimits(redisUrl: string | undefined): AllLimits {
  const outageLog = new RateLimitOutageLog();
  if (!redisUrl) {
    let reported = false;
    const unconfigured: AppRateLimit = {
      async admit(id) {
        if (!reported) {
          reported = true;
          outageLog.report("sign-in-rate-limits", new Error("REDIS_URL is not set"));
        }
        return NO_RATE_LIMIT.admit(id);
      },
    };
    return {
      signIn: { address: unconfigured, accountAddress: unconfigured, account: unconfigured },
      codeSend: { address: unconfigured, destination: unconfigured },
    };
  }
  const redis = openRedisClient(redisUrl);
  const limit = (keyPrefix: string, max: number, windowMs: number) =>
    new RedisAppRateLimit(redis, { keyPrefix, limit: max, windowMs, outageLog });
  return {
    signIn: {
      address: limit(
        "coforge:ratelimit:sign-in-address:v1",
        SIGN_IN_ADDRESS_LIMIT,
        SIGN_IN_WINDOW_MS,
      ),
      accountAddress: limit(
        "coforge:ratelimit:sign-in-account-address:v1",
        SIGN_IN_ACCOUNT_ADDRESS_LIMIT,
        SIGN_IN_WINDOW_MS,
      ),
      account: limit(
        "coforge:ratelimit:sign-in-account:v1",
        SIGN_IN_ACCOUNT_LIMIT,
        SIGN_IN_WINDOW_MS,
      ),
    },
    codeSend: {
      address: limit(
        "coforge:ratelimit:sign-in-code-address:v1",
        CODE_SEND_ADDRESS_LIMIT,
        CODE_SEND_WINDOW_MS,
      ),
      destination: limit(
        "coforge:ratelimit:sign-in-code-destination:v1",
        CODE_SEND_DESTINATION_LIMIT,
        CODE_SEND_WINDOW_MS,
      ),
    },
  };
}
