import { afterAll, expect, test } from "bun:test";
import { RedisClient } from "bun";

import {
  RateLimitOutageLog,
  RedisAppRateLimit,
  type RateLimitRedis,
} from "#src/server/app-rate-limits/app-rate-limit.server";

/** The Redis counter against a real Redis: allow N, refuse N+1 with the wait, reset with the
 * window, isolate ids, fail open when Redis is down. */

const url = Bun.env.APP_RATE_LIMIT_TEST_REDIS_URL;
if (!url) throw new Error("APP_RATE_LIMIT_TEST_REDIS_URL must target a scratch Redis");
const redis = new RedisClient(url);
afterAll(() => redis.close());

const outageLog = new RateLimitOutageLog();
const prefix = () => `coforge:test:ratelimit:${crypto.randomUUID()}`;

test("allows the limit, then refuses with the seconds left in the window", async () => {
  const limit = new RedisAppRateLimit(redis, {
    keyPrefix: prefix(),
    limit: 3,
    windowMs: 60_000,
    outageLog,
  });
  for (let i = 0; i < 3; i++) expect(await limit.admit("app")).toEqual({ allowed: true });
  const refused = await limit.admit("app");
  expect(refused.allowed).toBe(false);
  if (!refused.allowed) {
    expect(refused.retryAfterSeconds).toBeGreaterThan(55);
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(60);
  }
  expect((await limit.admit("app")).allowed).toBe(false);
});

test("the window resets after windowMs", async () => {
  const limit = new RedisAppRateLimit(redis, {
    keyPrefix: prefix(),
    limit: 1,
    windowMs: 300,
    outageLog,
  });
  expect((await limit.admit("app")).allowed).toBe(true);
  expect((await limit.admit("app")).allowed).toBe(false);
  await Bun.sleep(400);
  expect((await limit.admit("app")).allowed).toBe(true);
});

test("each id and each prefix counts separately", async () => {
  const limit = new RedisAppRateLimit(redis, {
    keyPrefix: prefix(),
    limit: 1,
    windowMs: 60_000,
    outageLog,
  });
  const other = new RedisAppRateLimit(redis, {
    keyPrefix: prefix(),
    limit: 1,
    windowMs: 60_000,
    outageLog,
  });
  expect((await limit.admit("a")).allowed).toBe(true);
  expect((await limit.admit("a")).allowed).toBe(false);
  expect((await limit.admit("b")).allowed).toBe(true);
  expect((await other.admit("a")).allowed).toBe(true);
});

/** Collects what `console.warn` is given while `run` goes. */
async function warnings(run: () => Promise<void>) {
  const lines: string[] = [];
  const warn = console.warn;
  console.warn = (line: string) => void lines.push(line);
  try {
    await run();
  } finally {
    console.warn = warn;
  }
  return lines;
}

test("Redis down admits, and logs once a minute across limiters", async () => {
  const down: RateLimitRedis = {
    send: async () => {
      throw new Error("connection refused");
    },
  };
  let now = 1_000_000;
  const shared = new RateLimitOutageLog(() => now);
  const first = new RedisAppRateLimit(down, {
    keyPrefix: "p1",
    limit: 1,
    windowMs: 60_000,
    outageLog: shared,
  });
  const second = new RedisAppRateLimit(down, {
    keyPrefix: "p2",
    limit: 1,
    windowMs: 60_000,
    outageLog: shared,
  });
  const lines = await warnings(async () => {
    for (let i = 0; i < 5; i++) {
      expect(await first.admit("app")).toEqual({ allowed: true });
      expect(await second.admit("app")).toEqual({ allowed: true });
    }
  });
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!)).toMatchObject({ event: "app_rate_limit:redis_unavailable" });
  now += 60_001;
  expect(await warnings(async () => void (await second.admit("app")))).toHaveLength(1);
});

test("a reply that is not two finite numbers admits and logs, never a NaN wait", async () => {
  for (const reply of ["OK", [5], [5, "x"], [5, Number.NaN], null, [2, 1, 0]]) {
    const odd: RateLimitRedis = { send: async () => reply };
    const limit = new RedisAppRateLimit(odd, {
      keyPrefix: "p",
      limit: 1,
      windowMs: 60_000,
      outageLog: new RateLimitOutageLog(),
    });
    const lines = await warnings(async () => {
      expect(await limit.admit("app")).toEqual({ allowed: true });
    });
    expect(lines).toHaveLength(1);
  }
});

test("an unreachable Redis admits", async () => {
  const unreachable = new RedisClient("redis://127.0.0.1:1", {
    maxRetries: 0,
    connectionTimeout: 500,
  });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const limit = new RedisAppRateLimit(unreachable, {
      keyPrefix: "p",
      limit: 1,
      windowMs: 60_000,
      outageLog: new RateLimitOutageLog(),
    });
    expect(await limit.admit("app")).toEqual({ allowed: true });
  } finally {
    console.warn = warn;
    unreachable.close();
  }
});
