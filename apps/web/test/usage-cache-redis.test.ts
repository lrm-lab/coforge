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
