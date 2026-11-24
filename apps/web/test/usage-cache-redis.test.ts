import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { RedisClient } from "bun";
import { RedisUsageCache } from "#src/server/centrifugo/usage-cache.server";
import { RedisAgentUsageCache } from "#src/server/centrifugo/agent-usage-cache.server";
import { RedisComputerCapabilityLease } from "#src/server/computers/computer-capability-lease.server";
import { DAEMON_AGENT_USAGE_SCAN_CAPABILITY } from "@lrm/coforge-sdk/internal";

// The cache's Lua scripts, run by a real Redis: a fake cannot say whether a claim is atomic or
// which results end which scan. Skipped when no `redis-server` is installed.
const redisServer = Bun.which("redis-server");
const port = 20_000 + Math.floor(Math.random() * 20_000);
let server: ReturnType<typeof Bun.spawn> | undefined;
let redis: RedisClient;
let cache: RedisUsageCache;

const key = (computerId: string) => ({ workspaceId: "w", computerId, provider: "codex" as const });
const scanKey = (computerId: string) =>
  `coforge:workspace:w:computer:${computerId}:usage:v2:codex:scan`;
const pending = (computerId: string, scanId: string) => ({
  ...key(computerId),
  scanId,
  status: "pending" as const,
});
const finished = (computerId: string, scanId: string, status: "available" | "error") => ({
  ...key(computerId),
  scanId,
  status,
  collectedAt: new Date().toISOString(),
  ...(status === "available" ? { snapshot: { provider: "codex" as const } } : {}),
});
const pendingId = async (computerId: string) => (await cache.read(key(computerId))).pendingScanId;

describe.skipIf(!redisServer)("RedisUsageCache scans against a real Redis", () => {
  beforeAll(async () => {
    server = Bun.spawn([redisServer!, "--port", String(port), "--save", "", "--appendonly", "no"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    redis = new RedisClient(`redis://127.0.0.1:${port}`);
    cache = new RedisUsageCache(redis);
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await redis.send("PING", []);
        return;
      } catch {
        await Bun.sleep(10);
      }
    }
    throw new Error("isolated redis-server did not become ready");
  });

  afterAll(async () => {
    redis?.close();
    server?.kill();
    await server?.exited;
  });

  test("concurrent claims agree on one scan, and the claim expires by itself", async () => {
    const ids = await Promise.all(
      ["a", "b", "c", "d"].map((id) => cache.claimScan(pending("concurrent", id))),
    );
    expect(new Set(ids).size).toBe(1);
    expect(await pendingId("concurrent")).toBe(ids[0]!);
    const ttl = Number(await redis.send("TTL", [scanKey("concurrent")]));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  test("an older scan's result leaves a newer claim standing, and the claim's own result ends it", async () => {
    await cache.claimScan(pending("late", "new"));
    await cache.putResult(finished("late", "old", "available"));
    await cache.putResult(finished("late", "older", "error"));
    expect(await pendingId("late")).toBe("new");
    expect(await cache.claimScan(pending("late", "other"))).toBe("new");

    await cache.putResult(finished("late", "new", "error"));
    expect(await pendingId("late")).toBeUndefined();
    expect(await cache.claimScan(pending("late", "next"))).toBe("next");
    await cache.putResult(finished("late", "next", "available"));
    expect(await pendingId("late")).toBeUndefined();
  });

  test("a scan is released by its own id only, and ended by whoever asks to end it", async () => {
    await cache.claimScan(pending("release", "one"));
    await cache.releaseScan(key("release"), "two");
    await cache.releaseScan(key("release"), "");
    expect(await pendingId("release")).toBe("one");
    await cache.releaseScan(key("release"), "one");
    expect(await pendingId("release")).toBeUndefined();

    await cache.claimScan(pending("release", "three"));
    await cache.endScan(key("release"));
    expect(await pendingId("release")).toBeUndefined();
  });

  test("a record that is not a pending scan neither holds the runtime nor survives a result", async () => {
    for (const garbage of ["not json", "null", "[]", '{"status":"done","scanId":"x"}']) {
      await redis.set(scanKey("garbage"), garbage, "EX", "60");
      expect(await cache.claimScan(pending("garbage", "fresh"))).toBe("fresh");
      expect(await pendingId("garbage")).toBe("fresh");
    }
    await redis.set(scanKey("garbage"), "not json", "EX", "60");
    await cache.putResult(finished("garbage", "any", "error"));
    expect(await redis.get(scanKey("garbage"))).toBeNull();
  });

  test("Agent usage binds the current worker, exact pending request, Agent and revision", async () => {
    const computer = "agent-usage";
    const capability = DAEMON_AGENT_USAGE_SCAN_CAPABILITY;
    const lease = new RedisComputerCapabilityLease(redis, capability, "agent-usage-test");
    const usage = new RedisAgentUsageCache(redis, lease);
    const current = {
      ...key(computer),
      agentId: "alpha",
      runtimeConfigRevision: 1,
      workerInstanceId: "worker-1",
    };
    const other = { ...current, agentId: "beta" };
    const updated = { ...current, runtimeConfigRevision: 2 };
    const nextWorker = { ...updated, workerInstanceId: "worker-2" };
    const reading = (scanId: string, accountLabel: string) => ({
      ...finished(computer, scanId, "available"),
      snapshot: { provider: "codex" as const, accountLabel },
    });

    expect(await usage.claim(current, "old-computer")).toBeUndefined();
    await lease.record(current.workspaceId, computer, [capability], {
      workerInstanceId: current.workerInstanceId,
      startedAt: 1,
    });
    expect(await lease.supportedWorker(current.workspaceId, computer)).toBe(
      current.workerInstanceId,
    );
    expect(await Promise.all([usage.claim(current, "a"), usage.claim(other, "b")])).toEqual([
      "a",
      "b",
    ]);
    expect(await usage.claim(current, "duplicate")).toBe("a");
    expect(await usage.complete(current, reading("b", "beta"))).toBe(false);
    expect(await usage.complete(updated, reading("a", "old revision"))).toBe(false);
    expect(await usage.complete(other, reading("b", "beta"))).toBe(true);
    expect(await usage.complete(current, reading("a", "alpha"))).toBe(true);
    expect(await usage.complete(current, reading("a", "duplicate"))).toBe(false);
    expect((await usage.read(current))?.result?.snapshot?.accountLabel).toBe("alpha");
    expect((await usage.read(other))?.result?.snapshot?.accountLabel).toBe("beta");
    expect(await usage.read(updated)).toEqual({ state: "missing", pendingScanId: undefined });
    expect(await usage.claim(updated, "stale-worker")).toBe("stale-worker");

    await lease.record(current.workspaceId, computer, [capability], {
      workerInstanceId: nextWorker.workerInstanceId,
      startedAt: 2,
    });
    expect(await usage.claim(nextWorker, "current-worker")).toBe("current-worker");
    expect(await usage.complete(updated, reading("stale-worker", "old process"))).toBe(false);
    expect(await usage.read(updated)).toBeUndefined();
    expect((await usage.read(nextWorker))?.pendingScanId).toBe("current-worker");
    await redis.del(lease.key(current.workspaceId, computer));
    expect(await usage.complete(nextWorker, reading("current-worker", "expired capability"))).toBe(
      false,
    );
    expect(await usage.read(nextWorker)).toBeUndefined();
    expect((await cache.read(key(computer))).result).toBeUndefined();
  });
});

test("RedisUsageCache.readMany reads multiple scopes in one mget and matches read()", async () => {
  const store = new Map<string, string>();
  let mgetCalls = 0;
  const nowMs = Date.parse("2026-11-24T00:10:00Z");
  const fakeRedis = {
    async set(k: string, v: string) {
      store.set(k, v);
      return "OK";
    },
    async get(k: string) {
      return store.get(k) ?? null;
    },
    async mget(...ks: string[]) {
      mgetCalls += 1;
      return ks.map((k) => store.get(k) ?? null);
    },
    async del(...ks: string[]) {
      let removed = 0;
      for (const k of ks) if (store.delete(k)) removed += 1;
      return removed;
    },
    async eval() {
      return null;
    },
  };
  const unitCache = new RedisUsageCache(fakeRedis, undefined, undefined, () => nowMs);
  expect(await unitCache.readMany([])).toEqual([]);
  expect(mgetCalls).toBe(0);

  const k1 = { workspaceId: "w", computerId: "c1", provider: "codex" as const };
  const k2 = { workspaceId: "w", computerId: "c1", provider: "claude-code" as const };
  const k3 = { workspaceId: "w", computerId: "c2", provider: "codex" as const };
  store.set(
    "coforge:workspace:w:computer:c1:usage:v2:codex:result",
    JSON.stringify({
      ...k1,
      scanId: "s1",
      status: "available",
      collectedAt: "2026-11-24T00:05:00Z",
      snapshot: { provider: "codex", primary: { usedPercent: 72, windowDurationMinutes: 300 } },
    }),
  );
  store.set(
    "coforge:workspace:w:computer:c1:usage:v2:codex:attempt",
    JSON.stringify({ scanId: "s1", status: "available", occurredAt: "2026-11-24T00:05:00Z" }),
  );
  store.set(
    "coforge:workspace:w:computer:c1:usage:v2:claude-code:scan",
    JSON.stringify({ ...k2, scanId: "s2", status: "pending" }),
  );

  const batch = await unitCache.readMany([k1, k2, k3]);
  expect(mgetCalls).toBe(1);
  expect(batch).toEqual([
    await unitCache.read(k1),
    await unitCache.read(k2),
    await unitCache.read(k3),
  ]);
  expect(batch[0]?.state).toBe("fresh");
  expect(batch[0]?.result?.snapshot?.primary?.usedPercent).toBe(72);
  expect(batch[1]).toEqual({ state: "missing", pendingScanId: "s2" });
  expect(batch[2]).toEqual({ state: "missing", pendingScanId: undefined });
});

test("readListRuntimeUsages enforces owner/admin permissions and redacts non-owner readings", async () => {
  const { readListRuntimeUsages } =
    await import("#src/server/computers/computer-list-usage.server");
  const fullReading = {
    state: "fresh" as const,
    result: {
      workspaceId: "w",
      computerId: "c-theirs",
      provider: "codex" as const,
      scanId: "s1",
      status: "available" as const,
      message: "raw debug",
      collectedAt: "2026-11-24T00:05:00Z",
      snapshot: {
        provider: "codex" as const,
        primary: { usedPercent: 80, windowDurationMinutes: 300 },
        credits: { hasCredits: true, unlimited: false, balance: "99.00" },
      },
    },
  };
  let requestedCount = 0;
  const memberResult = await readListRuntimeUsages({
    workspaceId: "w",
    userId: "u-member",
    canManage: false,
    computers: [{ id: "c-theirs", ownerId: "u-owner", kind: "local" }],
    runtimes: [
      { computerId: "c-theirs", provider: "codex", isPublic: true, unavailableCode: null },
    ],
    readMany: async (keys) => {
      requestedCount += keys.length;
      return [fullReading];
    },
  });
  expect(requestedCount).toBe(0);
  expect(memberResult.size).toBe(0);

  const adminResult = await readListRuntimeUsages({
    workspaceId: "w",
    userId: "u-admin",
    canManage: true,
    computers: [
      { id: "c-theirs", ownerId: "u-owner", kind: "local" },
      { id: "c-default-cloud", ownerId: "u-owner", kind: "cloud", cloudSlot: "default" },
    ],
    runtimes: [
      { computerId: "c-theirs", provider: "codex", isPublic: true, unavailableCode: null },
      { computerId: "c-theirs", provider: "claude-code", isPublic: false, unavailableCode: null },
      { computerId: "c-theirs", provider: "pi", isPublic: true, unavailableCode: null },
      { computerId: "c-default-cloud", provider: "codex", isPublic: true, unavailableCode: null },
    ],
    readMany: async (keys) => {
      expect(keys).toHaveLength(1);
      expect(keys[0]?.computerId).toBe("c-theirs");
      expect(keys[0]?.provider).toBe("codex");
      return [fullReading];
    },
  });
  expect(adminResult.get("c-default-cloud")).toBeUndefined();
  expect(adminResult.get("c-theirs")?.["claude-code"]).toBeUndefined();
  expect(adminResult.get("c-theirs")?.codex?.result?.snapshot?.credits?.balance).toBeUndefined();
  expect(adminResult.get("c-theirs")?.codex?.result?.message).toBeUndefined();
  expect(adminResult.get("c-theirs")?.codex?.result?.snapshot?.primary?.usedPercent).toBe(80);
});
