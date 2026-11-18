import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import {
  RateLimitOutageLog,
  RedisAppRateLimit,
} from "#src/server/app-rate-limits/app-rate-limit.server";
import type {
  PeekableRateLimit,
  RateLimitDecision,
} from "#src/server/app-rate-limits/app-rate-limit.server";
import { PublicArtifactMissGuard } from "#src/server/artifacts/artifact-public-miss-guard.server";

function counter(limit: number): PeekableRateLimit & { counts: Map<string, number> } {
  const counts = new Map<string, number>();
  const decide = (id: string): RateLimitDecision =>
    (counts.get(id) ?? 0) <= limit ? { allowed: true } : { allowed: false, retryAfterSeconds: 30 };
  return {
    counts,
    async admit(id) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
      return decide(id);
    },
    async peek(id) {
      return (counts.get(id) ?? 0) < limit
        ? { allowed: true }
        : { allowed: false, retryAfterSeconds: 30 };
    },
  };
}

let warn: ReturnType<typeof spyOn>;
beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => mock.restore());

const guard = (perClient = counter(20), global = counter(300), now = () => 0) =>
  new PublicArtifactMissGuard({ perClient, global, now });

test("a client's 21st miss in a window is refused, before any lookup", async () => {
  const g = guard();
  for (let i = 0; i < 20; i++) {
    expect(await g.refusal("192.0.2.1")).toBeNull();
    await g.miss("192.0.2.1");
  }
  expect(await g.refusal("192.0.2.1")).toEqual({ retryAfterSeconds: 30 });
});

test("another client is not affected by one client's misses", async () => {
  const g = guard();
  for (let i = 0; i < 25; i++) await g.miss("192.0.2.1");
  expect(await g.refusal("192.0.2.1")).not.toBeNull();
  expect(await g.refusal("192.0.2.2")).toBeNull();
});

test("past the global threshold it only logs, naming the client, and never refuses", async () => {
  const global = counter(3);
  const g = guard(counter(1000), global);
  for (let i = 0; i < 6; i++) await g.miss(`192.0.2.${i}`);
  const events = warn.mock.calls.map((call: unknown[]) => JSON.parse(String(call[0])));
  expect(events.filter((e: { event: string }) => e.event === "artifact_link_guessing")).toEqual([
    expect.objectContaining({ client: "192.0.2.3" }),
    expect.objectContaining({ client: "192.0.2.4" }),
    expect.objectContaining({ client: "192.0.2.5" }),
  ]);
  expect(await g.refusal("192.0.2.9")).toBeNull();
});

test("the global log is capped per minute", async () => {
  let now = 0;
  const g = guard(counter(1000), counter(0), () => now);
  for (let i = 0; i < 20; i++) await g.miss(`192.0.2.${i}`);
  expect(warn.mock.calls.length).toBe(5);
  now = 61_000;
  await g.miss("192.0.2.99");
  expect(warn.mock.calls.length).toBe(6);
});

test("with Redis down it admits everything and logs the outage", async () => {
  const redis = {
    send: async () => {
      throw new Error("connection refused");
    },
  };
  const options = { limit: 20, windowMs: 60_000, outageLog: new RateLimitOutageLog() };
  const g = new PublicArtifactMissGuard({
    perClient: new RedisAppRateLimit(redis, { ...options, keyPrefix: "miss" }),
    global: new RedisAppRateLimit(redis, { ...options, keyPrefix: "miss-all", limit: 300 }),
    now: () => 0,
  });
  for (let i = 0; i < 25; i++) {
    expect(await g.refusal("192.0.2.1")).toBeNull();
    await g.miss("192.0.2.1");
  }
  const events = warn.mock.calls.map((call: unknown[]) => JSON.parse(String(call[0])).event);
  expect(events).toContain("app_rate_limit:redis_unavailable");
  expect(events).not.toContain("artifact_link_guessing");
});
