import { describe, expect, test } from "bun:test";
import type { RedisClient } from "bun";
import type { AgentStatus } from "@lrm/coforge-sdk/internal";
import { RedisAgentDisplay } from "#src/server/agents/agent-display.server";
import { workspaceRedisKey } from "#src/server/redis-keys.server";
import { redisServer, startRedisFixture, useRedisFixture } from "./helpers/redis-fixture";

let redis: RedisClient;
let now = 1_000_000;

const scope = { workspaceId: "workspace-a", computerId: "computer-a", agentId: "agent-a" };
const status = (sequence: number): AgentStatus => ({
  protocolMajor: 1,
  requestId: `status-${sequence}`,
  ...scope,
  status: "active",
  daemonInstanceId: "daemon-a",
  clientSeq: sequence,
  observedAtMs: sequence * 100,
});

describe.skipIf(!redisServer)("RedisAgentDisplay batch reads", () => {
  useRedisFixture((client) => {
    redis = client();
  });

  test("concurrent Redis fixtures isolate their clients and keys", async () => {
    const fixtures = await Promise.allSettled([startRedisFixture(), startRedisFixture()]);
    try {
      const [firstResult, secondResult] = fixtures;
      if (firstResult.status === "rejected") throw firstResult.reason;
      if (secondResult.status === "rejected") throw secondResult.reason;
      const first = firstResult.value;
      const second = secondResult.value;
      const writer = first.client();
      const reader = first.client();
      const separate = second.client();
      await writer.set("shared-name", "first fixture");
      expect(await reader.get("shared-name")).toBe("first fixture");
      expect(await separate.get("shared-name")).toBeNull();

      await first.stop();
      await first.stop();
      expect(await separate.send("PING", [])).toBe("PONG");
    } finally {
      await Promise.all(
        fixtures.map((result) => result.status === "fulfilled" && result.value.stop()),
      );
    }
  }, 25_000);

  const display = () => new RedisAgentDisplay(redis, () => now);

  test("reads many Agents' displays in one round trip, in the scopes' order", async () => {
    await redis.send("FLUSHDB", []);
    now = 6_400_000;
    let evals = 0;
    const counted = new Proxy(redis, {
      get(target, property) {
        if (property === "eval")
          return (script: string, keys: number, ...args: Array<string | number>) => {
            evals += 1;
            return target.eval(script, keys, ...args);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as typeof redis;
    const subject = new RedisAgentDisplay(counted, () => now);
    const other = { workspaceId: "workspace-a", computerId: "computer-a", agentId: "agent-b" };
    await subject.observeStatus(status(1));
    await subject.observeStatus({ ...status(1), ...other, requestId: "status-other" });
    evals = 0;

    const snapshots = await subject.snapshotMany([scope, other]);
    expect(snapshots.map((entry) => entry.agentId)).toEqual([scope.agentId, other.agentId]);
    // The batch answer is the answer the single-scope reader gives, per scope — the batch reader is
    // the same script body, so this is the contract that must not drift.
    expect(snapshots[0]).toEqual(await subject.snapshot(scope));
    expect(snapshots[1]).toEqual(await subject.snapshot(other));
    // One round trip for the pair, then one each for the two single reads it is compared against.
    expect(evals).toBe(3);
    // Nothing to read is no round trip.
    expect(await subject.snapshotMany([])).toEqual([]);
    expect(evals).toBe(3);
  });

  test("a batch bumps each scope's own revision counter, not the first scope's", async () => {
    await redis.send("FLUSHDB", []);
    const subject = display();
    const other = { workspaceId: "workspace-a", computerId: "computer-a", agentId: "agent-b" };
    // Scope A's counter sits far above Redis TIME's microsecond floor; scope B has never been
    // written, so its first-write revision must come from B's own (absent) counter.
    const seeded = 9_000_000_000_000_000;
    await redis.send("SET", [
      `${workspaceRedisKey({ ...scope, name: "display", version: "v1" })}:revision`,
      String(seeded),
    ]);
    const [first, second] = await subject.snapshotMany([scope, other]);
    expect(first!.revision).toBeGreaterThan(seeded);
    expect(second!.revision).toBeLessThan(seeded);
    // The counter written for B is B's own, and a later single read agrees with the batch.
    expect((await subject.snapshot(other)).revision).toBe(second!.revision);
  });
});
