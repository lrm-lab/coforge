import { describe, expect, test } from "bun:test";
import { RedisClient } from "bun";
import {
  LocalAgentControlSignal,
  RedisAgentControlSignal,
} from "#src/server/agents/agent-control-signal.server";
import { redisServer, useRedisFixture } from "./helpers/redis-fixture";

describe("LocalAgentControlSignal", () => {
  test("notify wakes every waiter for that Agent only", async () => {
    const signal = new LocalAgentControlSignal();
    const order: string[] = [];
    const a1 = signal.wait("a", 5_000).then(() => order.push("a1"));
    const a2 = signal.wait("a", 5_000).then(() => order.push("a2"));
    const b = signal.wait("b", 50).then(() => order.push("b"));
    await signal.notify("a");
    await Promise.all([a1, a2]);
    expect(order).toEqual(["a1", "a2"]);
    await b;
    expect(order).toEqual(["a1", "a2", "b"]);
  });

  test("wakeAll wakes every waiter, so each re-reads after a lost signal", async () => {
    const signal = new LocalAgentControlSignal();
    const woken = Promise.all([signal.wait("a", 5_000), signal.wait("b", 5_000)]);
    signal.wakeAll();
    expect(await woken).toEqual([true, true]);
  });

  test("the fallback timeout resolves a waiter without a signal", async () => {
    const signal = new LocalAgentControlSignal();
    const started = Date.now();
    await signal.wait("a", 20);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
    await signal.wait("a", 0);
  });

  test("remember leaves a marker remembered() still sees, scoped to its key", async () => {
    const signal = new LocalAgentControlSignal();
    expect(await signal.remembered("accepted:req-1")).toBe(false);
    await signal.remember("accepted:req-1");
    expect(await signal.remembered("accepted:req-1")).toBe(true);
    expect(await signal.remembered("accepted:req-2")).toBe(false);
    expect(await signal.remembered("agent-a")).toBe(false);
  });
});

describe.skipIf(!redisServer)("RedisAgentControlSignal", () => {
  const client = useRedisFixture();

  test("a notify on one instance wakes a waiter on another", async () => {
    const waiterSide = new RedisAgentControlSignal(client(), client);
    const notifierSide = new RedisAgentControlSignal(client(), client);
    // First wait establishes the subscription; give it a moment before publishing.
    await waiterSide.wait("warm-up", 20);
    const started = Date.now();
    const woken = waiterSide.wait("agent-a", 5_000);
    await Bun.sleep(20);
    await notifierSide.notify("agent-a");
    await woken;
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("a remember on one instance is seen by remembered() on another", async () => {
    const writer = new RedisAgentControlSignal(client(), client);
    const reader = new RedisAgentControlSignal(client(), client);
    await writer.remember("accepted:req-x");
    expect(await reader.remembered("accepted:req-x")).toBe(true);
    expect(await reader.remembered("accepted:req-y")).toBe(false);
  });

  test("notify survives a publisher outage and the waiter falls back to its timeout", async () => {
    const broken = new RedisClient("redis://127.0.0.1:1");
    try {
      const signal = new RedisAgentControlSignal(broken, () => broken);
      const started = Date.now();
      await signal.notify("agent-a");
      await signal.wait("agent-a", 30);
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(25);
      expect(elapsed).toBeLessThan(1_000);
    } finally {
      broken.close();
    }
  });
});
