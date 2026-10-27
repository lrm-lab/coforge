import { createHash } from "node:crypto";
import { afterEach, expect, spyOn, test } from "bun:test";

import type { AppRateLimit } from "#src/server/app-rate-limits/app-rate-limit.server";
import type { AuthingConfig } from "#src/server/auth/authing-authentication.server";
import { signInWithPassword } from "#src/server/auth/password-sign-in.server";
import {
  admitSignIn,
  SIGN_IN_ACCOUNT_ADDRESS_LIMIT,
  SIGN_IN_ACCOUNT_LIMIT,
  SIGN_IN_ADDRESS_LIMIT,
  SIGN_IN_WINDOW_MS,
  type SignInRateLimits,
} from "#src/server/auth/sign-in-rate-limits.server";

// Password sign-in is limited per client address, per account from one address, and per account
// from anywhere, before Authing is called: Authing sees every call from this server's address, so
// its own per-address limits protect nobody. The account is never limited below what one address
// can spend, or that address could lock a victim out.

const email = "Ada@Example.com";
const password = "password-secret-7f3a";
const address = "203.0.113.7";

/** Admits `limit` ids of each kind, then refuses; remembers every id it was asked about. */
function countingLimit(limit: number) {
  const seen: string[] = [];
  const counts = new Map<string, number>();
  const limiter: AppRateLimit = {
    async admit(id) {
      seen.push(id);
      const count = (counts.get(id) ?? 0) + 1;
      counts.set(id, count);
      return count <= limit ? { allowed: true } : { allowed: false, retryAfterSeconds: 60 };
    },
  };
  return { limiter, seen };
}

function limits(
  addressLimit = SIGN_IN_ADDRESS_LIMIT,
  pairLimit = SIGN_IN_ACCOUNT_ADDRESS_LIMIT,
  accountLimit = SIGN_IN_ACCOUNT_LIMIT,
) {
  const byAddress = countingLimit(addressLimit);
  const byPair = countingLimit(pairLimit);
  const byAccount = countingLimit(accountLimit);
  const rateLimits: SignInRateLimits = {
    address: byAddress.limiter,
    accountAddress: byPair.limiter,
    account: byAccount.limiter,
  };
  return {
    rateLimits,
    addresses: byAddress.seen,
    pairs: byPair.seen,
    accounts: byAccount.seen,
  };
}

test("the limits are 20 attempts per address, 10 per account and address, 50 per account", () => {
  expect(SIGN_IN_ADDRESS_LIMIT).toBe(20);
  expect(SIGN_IN_ACCOUNT_ADDRESS_LIMIT).toBe(10);
  expect(SIGN_IN_ACCOUNT_LIMIT).toBe(50);
  expect(SIGN_IN_WINDOW_MS).toBe(15 * 60_000);
});

test("no single address can spend an account's whole limit", () => {
  expect(SIGN_IN_ACCOUNT_ADDRESS_LIMIT).toBeLessThan(SIGN_IN_ACCOUNT_LIMIT);
  expect(SIGN_IN_ADDRESS_LIMIT).toBeLessThan(SIGN_IN_ACCOUNT_LIMIT);
});

test("the account is counted by the hash of its trimmed, lower-cased form, never raw", async () => {
  const { rateLimits, accounts, pairs, addresses } = limits();
  await admitSignIn(rateLimits, { account: `  ${email} `, clientAddress: address });
  await admitSignIn(rateLimits, { account: email.toLowerCase(), clientAddress: address });
  const hash = createHash("sha256").update("ada@example.com").digest("hex");
  expect(accounts).toEqual([hash, hash]);
  expect(addresses).toEqual([address, address]);
  // The pair is counted by one hash of both, so Redis holds neither the email nor the address.
  expect(pairs).toHaveLength(2);
  expect(pairs[0]).toBe(pairs[1]!);
  expect(pairs[0]).toMatch(/^[0-9a-f]{64}$/);
  expect(pairs[0]).not.toBe(hash);
});

test("without a client address only the account is limited, across all addresses", async () => {
  const { rateLimits, accounts, addresses, pairs } = limits();
  expect(await admitSignIn(rateLimits, { account: email })).toEqual({ allowed: true });
  expect(addresses).toEqual([]);
  expect(pairs).toEqual([]);
  expect(accounts).toHaveLength(1);
});

test("an address over its limit is refused as the address, without counting the account", async () => {
  const { rateLimits, accounts, pairs } = limits(1);
  expect(await admitSignIn(rateLimits, { account: email, clientAddress: address })).toEqual({
    allowed: true,
  });
  expect(await admitSignIn(rateLimits, { account: email, clientAddress: address })).toEqual({
    allowed: false,
    limit: "address",
  });
  expect(pairs).toHaveLength(1);
  expect(accounts).toHaveLength(1);
});

test("one address over the account limit is refused without counting the account's total", async () => {
  const { rateLimits, accounts } = limits(100, 2);
  for (let attempt = 0; attempt < 2; attempt++) {
    expect(await admitSignIn(rateLimits, { account: email, clientAddress: address })).toEqual({
      allowed: true,
    });
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    expect(await admitSignIn(rateLimits, { account: email, clientAddress: address })).toEqual({
      allowed: false,
      limit: "account_address",
    });
  }
  // Only the two admitted attempts reached the total, so the address cannot spend the rest of it.
  expect(accounts).toHaveLength(2);
  expect(await admitSignIn(rateLimits, { account: email, clientAddress: "203.0.113.8" })).toEqual({
    allowed: true,
  });
});

test("an account over its limit across addresses is refused as the account", async () => {
  const { rateLimits } = limits(100, 100, 2);
  for (const from of ["203.0.113.1", "203.0.113.2"]) {
    expect(await admitSignIn(rateLimits, { account: email, clientAddress: from })).toEqual({
      allowed: true,
    });
  }
  expect(await admitSignIn(rateLimits, { account: email, clientAddress: "203.0.113.3" })).toEqual({
    allowed: false,
    limit: "account",
  });
});

test("an attempt with no account is limited by its address alone", async () => {
  const { rateLimits, accounts, pairs } = limits(1);
  expect(await admitSignIn(rateLimits, { clientAddress: address })).toEqual({ allowed: true });
  expect(await admitSignIn(rateLimits, { clientAddress: address })).toEqual({
    allowed: false,
    limit: "address",
  });
  expect(await admitSignIn(rateLimits, {})).toEqual({ allowed: true });
  expect(accounts).toEqual([]);
  expect(pairs).toEqual([]);
});

const config: AuthingConfig = {
  appId: "6a8fde6fa804dd3bea560bac",
  appSecret: "test-app-secret",
  appHost: "https://coforge.authing.cn",
  userinfoEndpoint: "https://coforge.authing.cn/oidc/me",
  revocationEndpoint: "https://coforge.authing.cn/oidc/token/revocation",
};
const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
});

/** A real HTTP Authing that refuses every sign-in and records the bodies it received. */
function authing() {
  const bodies: Array<{ options?: { clientIp?: string } }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      bodies.push((await request.json()) as { options?: { clientIp?: string } });
      return Response.json({ statusCode: 400, apiCode: 2333, message: "no" });
    },
  });
  servers.push(server);
  return { config: { ...config, appHost: server.url.origin }, bodies };
}

async function attempt(
  input: { authing: ReturnType<typeof authing>; rateLimits: SignInRateLimits } & {
    clientAddress?: string;
  },
) {
  const warnings: string[] = [];
  const spy = spyOn(console, "warn").mockImplementation((line: unknown) => {
    warnings.push(String(line));
  });
  try {
    const result = await signInWithPassword({
      config: input.authing.config,
      sessionSecret: "test-session-secret-at-least-32-characters",
      secure: false,
      credentials: { email, password },
      rateLimits: input.rateLimits,
      ...(input.clientAddress ? { clientAddress: input.clientAddress } : {}),
    });
    return { result, warnings };
  } finally {
    spy.mockRestore();
  }
}

test("a sign-in over a limit is refused before Authing is called, and logged without who", async () => {
  const stand = authing();
  const { rateLimits } = limits(100, 100, 1);
  const first = await attempt({ authing: stand, rateLimits, clientAddress: address });
  expect(first.result).toEqual({ status: "invalid_credentials" });
  expect(stand.bodies).toHaveLength(1);

  const second = await attempt({ authing: stand, rateLimits, clientAddress: address });
  expect(second.result).toEqual({ status: "rate_limited" });
  expect(stand.bodies).toHaveLength(1);
  expect(second.warnings.map((line) => JSON.parse(line))).toEqual([
    { event: "auth.sign_in_rate_limited", limit: "account" },
  ]);
  const logged = second.warnings.join("\n");
  expect(logged).not.toContain(address);
  expect(logged.toLowerCase()).not.toContain("example.com");
});

test("an address over its limit is logged as the address", async () => {
  const stand = authing();
  const { rateLimits } = limits(0);
  const { result, warnings } = await attempt({
    authing: stand,
    rateLimits,
    clientAddress: address,
  });
  expect(result).toEqual({ status: "rate_limited" });
  expect(stand.bodies).toHaveLength(0);
  expect(warnings.map((line) => JSON.parse(line))).toEqual([
    { event: "auth.sign_in_rate_limited", limit: "address" },
  ]);
});

test("Authing is told the client address, and none when there is none", async () => {
  const stand = authing();
  const { rateLimits } = limits();
  await attempt({ authing: stand, rateLimits, clientAddress: address });
  await attempt({ authing: stand, rateLimits });
  expect(stand.bodies[0]?.options?.clientIp).toBe(address);
  expect(stand.bodies[1]?.options).not.toHaveProperty("clientIp");
});
