import { expect, test } from "bun:test";
import {
  FAILED_USAGE_STALE_AFTER_MS,
  RedisUsageCache,
  USAGE_STALE_AFTER_MS,
} from "#src/server/centrifugo/usage-cache.server";

function fakeRedis() {
  const values = new Map<string, string>();
  const calls: string[] = [];
  return {
    calls,
    values,
    async set(key: string, value: string, ex: "EX", seconds: string) {
      calls.push(`set:${key}:${ex}:${seconds}`);
      values.set(key, value);
    },
    async get(key: string) {
      return values.get(key) ?? null;
    },
    async del(...keys: string[]) {
      let removed = 0;
      for (const key of keys) if (values.delete(key)) removed += 1;
      calls.push(`del:${keys.join(",")}`);
      return removed;
    },
    // PUT_SUCCESS writes three keys (reading, attempt, scan); PUT_ATTEMPT writes two (attempt,
    // scan). KEYS come first, then ARGV.
    async eval(_script: string, numberOfKeys: number, ...keysAndArgs: Array<string | number>) {
      if (numberOfKeys === 3) {
        values.set(String(keysAndArgs[0]), String(keysAndArgs[3]));
        values.set(String(keysAndArgs[1]), String(keysAndArgs[4]));
        values.delete(String(keysAndArgs[2]));
      } else {
        values.set(String(keysAndArgs[0]), String(keysAndArgs[2]));
        values.delete(String(keysAndArgs[1]));
      }
      calls.push(`eval:${numberOfKeys}`);
      return 1;
    },
  };
}

const key = { workspaceId: "w1", computerId: "c1", provider: "codex" as const };
const T0 = Date.parse("2026-09-17T00:00:00Z");

/** One cache over a mutable clock, so a test can age a reading or an attempt. */
function clockCache(redis: ReturnType<typeof fakeRedis>) {
  let now = T0;
  return {
    cache: new RedisUsageCache(redis, "86400", "60", () => now),
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

test("a missing key reports state missing with no result", async () => {
  const redis = fakeRedis();
  const cache = new RedisUsageCache(redis);
  await expect(cache.read(key)).resolves.toEqual({ state: "missing" });
});

test("a successful reading reads back fresh, scoped to a versioned per-provider key", async () => {
  const redis = fakeRedis();
  const { cache } = clockCache(redis);
  await cache.putResult({
    ...key,
    scanId: "scan-1",
    status: "available",
    snapshot: { provider: "codex", planType: "pro" },
    collectedAt: "2026-09-17T00:00:00Z",
  });
  await expect(cache.read(key)).resolves.toMatchObject({
    state: "fresh",
    result: { scanId: "scan-1", snapshot: { planType: "pro" } },
  });
  expect(redis.values.has("coforge:workspace:w1:computer:c1:usage:v2:codex:result")).toBe(true);
});

test("a reading older than the window reads back stale, not missing", async () => {
  const redis = fakeRedis();
  const { cache, advance } = clockCache(redis);
  await cache.putResult({
    ...key,
    scanId: "scan-1",
    status: "available",
    snapshot: { provider: "codex", planType: "pro" },
    collectedAt: "2026-09-17T00:00:00Z",
  });
  advance(USAGE_STALE_AFTER_MS + 1);
  await expect(cache.read(key)).resolves.toMatchObject({ state: "stale" });
});

test("starting a new scan never erases the previous reading", async () => {
  const redis = fakeRedis();
  const { cache } = clockCache(redis);
  await cache.putResult({
    ...key,
    scanId: "scan-1",
    status: "available",
    snapshot: { provider: "codex", planType: "pro" },
    collectedAt: "2026-09-17T00:00:00Z",
  });
  await cache.putScan({ ...key, scanId: "scan-2", status: "pending" });

  const read = await cache.read(key);
  expect(read.result?.scanId).toBe("scan-1");
  expect(read.result?.snapshot?.planType).toBe("pro");
  expect(read.pendingScanId).toBe("scan-2");
});

test("a completed scan clears its own pending marker so it stops reporting as pending", async () => {
  const redis = fakeRedis();
  const { cache } = clockCache(redis);
  await cache.putScan({ ...key, scanId: "scan-1", status: "pending" });
  expect((await cache.read(key)).pendingScanId).toBe("scan-1");

  await cache.putResult({
    ...key,
    scanId: "scan-1",
    status: "available",
    snapshot: { provider: "codex" },
    collectedAt: "2026-09-17T00:00:00Z",
  });
  const read = await cache.read(key);
  expect(read.pendingScanId).toBeUndefined();
  expect(read.result?.scanId).toBe("scan-1");
});

test("an old Daemon's reading without its own collectedAt still carries the server-assigned one", async () => {
  const redis = fakeRedis();
  const { cache } = clockCache(redis);
  // The caller (the scan-result RPC method) is what falls back to server-receive time when the
  // snapshot itself is silent; the cache just stores and classifies whatever `collectedAt` it's
  // given.
  await cache.putResult({
    ...key,
    scanId: "scan-1",
    status: "available",
    snapshot: { provider: "codex" },
    collectedAt: "2026-09-17T00:00:00.000Z",
  });
  await expect(cache.read(key)).resolves.toMatchObject({
    state: "fresh",
    result: { collectedAt: "2026-09-17T00:00:00.000Z" },
  });
});

test("a successful scan writes the reading, its attempt and clears the pending marker in one call", async () => {
  const redis = fakeRedis();
  const { cache } = clockCache(redis);
  await cache.putScan({ ...key, scanId: "scan-1", status: "pending" });
  redis.calls.length = 0;

  await cache.putResult({
    ...key,
    scanId: "scan-1",
    status: "available",
    snapshot: { provider: "codex" },
    collectedAt: "2026-09-17T00:00:00Z",
  });

  expect(redis.calls).toEqual(["eval:3"]);
  expect((await cache.read(key)).pendingScanId).toBeUndefined();
});

test("a failed scan keeps a reading older than 30 minutes and does not re-scan within 2 minutes", async () => {
  const redis = fakeRedis();
  const { cache, advance } = clockCache(redis);
  await cache.putResult({
    ...key,
    scanId: "scan-1",
    status: "available",
    snapshot: { provider: "codex", planType: "pro" },
    collectedAt: "2026-09-17T00:00:00Z",
  });

  // The success is now long past its 30-minute window. A failed attempt must not leave the entry
  // permanently stale (which every page load would re-scan): freshness follows the attempt.
  advance(40 * 60_000);
  await cache.putScan({ ...key, scanId: "scan-2", status: "pending" });
  await cache.putResult({
    ...key,
    scanId: "scan-2",
    status: "unavailable",
    message: "Provider usage is unavailable",
    collectedAt: "2026-09-17T00:40:00Z",
  });

  const read = await cache.read(key);
  expect(read.state).toBe("fresh");
  expect(read.pendingScanId).toBeUndefined();
  expect(read.result).toMatchObject({
    scanId: "scan-2",
    status: "unavailable",
    collectedAt: "2026-09-17T00:00:00Z",
    snapshot: { planType: "pro" },
  });

  advance(FAILED_USAGE_STALE_AFTER_MS + 1);
  expect((await cache.read(key)).state).toBe("stale");
});

test("a reauthentication failure does not keep showing the last reading", async () => {
  const redis = fakeRedis();
  const { cache } = clockCache(redis);
  await cache.putResult({
    ...key,
    scanId: "scan-1",
    status: "available",
    snapshot: { provider: "codex", planType: "pro" },
    collectedAt: "2026-09-17T00:00:00Z",
  });
  await cache.putResult({
    ...key,
    scanId: "scan-2",
    status: "reauth",
    collectedAt: "2026-09-17T00:00:00Z",
  });

  const read = await cache.read(key);
  expect(read.result?.status).toBe("reauth");
  expect(read.result?.snapshot).toBeUndefined();
});

test("a failed scan with no earlier reading is recorded as the failure", async () => {
  const redis = fakeRedis();
  const { cache } = clockCache(redis);
  await cache.putResult({
    ...key,
    scanId: "scan-1",
    status: "unavailable",
    collectedAt: "2026-09-17T00:00:00Z",
  });
  await expect(cache.read(key)).resolves.toMatchObject({
    state: "fresh",
    result: { scanId: "scan-1", status: "unavailable" },
  });
});

test("a failed attempt stays fresh for two minutes, then reads stale", async () => {
  const redis = fakeRedis();
  const { cache, advance } = clockCache(redis);
  await cache.putResult({
    ...key,
    scanId: "scan-1",
    status: "error",
    collectedAt: "2026-09-17T00:00:00Z",
  });
  expect((await cache.read(key)).state).toBe("fresh");
  advance(FAILED_USAGE_STALE_AFTER_MS - 1);
  expect((await cache.read(key)).state).toBe("fresh");
  advance(2);
  await expect(cache.read(key)).resolves.toMatchObject({
    state: "stale",
    result: { scanId: "scan-1", status: "error" },
  });
});

test("a reading written before attempts were recorded still reads", async () => {
  const redis = fakeRedis();
  const { cache, advance } = clockCache(redis);
  redis.values.set(
    "coforge:workspace:w1:computer:c1:usage:v2:codex:result",
    JSON.stringify({
      ...key,
      scanId: "scan-1",
      status: "available",
      snapshot: { provider: "codex", planType: "pro" },
      collectedAt: "2026-09-17T00:00:00Z",
    }),
  );
  expect((await cache.read(key)).state).toBe("fresh");
  advance(USAGE_STALE_AFTER_MS + 1);
  expect((await cache.read(key)).state).toBe("stale");
});
