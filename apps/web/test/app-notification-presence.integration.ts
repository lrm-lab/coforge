import { afterAll, beforeEach, expect, test } from "bun:test";
import { RedisClient } from "bun";

import { RedisAgentStatusCache } from "#src/server/agents/agent-status.server";
import { AppNotificationPresence } from "#src/server/app-notifications/app-notification-presence.server";
import type { AppNotificationEvent } from "#src/server/app-notifications/app-notification-event";
import type { PresenceObserver } from "#src/server/app-notifications/presence-observer";
import { PresenceSweep } from "#src/server/app-notifications/presence-sweep.server";
import { RedisComputerStatusCache } from "#src/server/centrifugo/computer-status.server";

/** The presence scripts and sweep against a real Redis (`APP_PRESENCE_TEST_REDIS_URL`, a scratch
 * one): the previous value for each ordering case, the expiry index, and the sweep claiming a
 * lapsed lease once however many instances race for it, with a one-second lease. */

const url = Bun.env.APP_PRESENCE_TEST_REDIS_URL;
if (!url) throw new Error("APP_PRESENCE_TEST_REDIS_URL must target a scratch Redis");
const redis = new RedisClient(url);
afterAll(() => redis.close());

const expiryKey = `coforge:test:presence-expiry:${crypto.randomUUID()}`;
const zscore = async (member: string) => {
  const score = await redis.send("ZSCORE", [expiryKey, member]);
  return score === null ? null : Number(score);
};

type Seen = {
  agent: Array<{ from: string; to: string }>;
  computer: Array<{ from: string; to: string }>;
};
let seen: Seen;
const observer: PresenceObserver = {
  enabled: () => true,
  agentStatus: (change) => void seen.agent.push(change),
  computerPresence: (change) => void seen.computer.push(change),
};
beforeEach(() => {
  seen = { agent: [], computer: [] };
});

const ids = () => ({
  workspaceId: crypto.randomUUID(),
  computerId: crypto.randomUUID(),
  agentId: crypto.randomUUID(),
});
const agentCache = () =>
  new RedisAgentStatusCache(redis, { presence: observer, expiryKey, ttlSeconds: "1" });
const computerCache = () =>
  new RedisComputerStatusCache(redis, "1", { presence: observer, redis, expiryKey });
const put = (
  cache: RedisAgentStatusCache,
  scope: ReturnType<typeof ids>,
  status: "active" | "inactive",
  clientSeq: number,
  observedAtMs: number,
  daemonInstanceId = "d1",
) => cache.put({ ...scope, status, clientSeq, observedAtMs, daemonInstanceId });

test("Agent previous status through every ordering case", async () => {
  const cache = agentCache();
  const scope = ids();
  expect(await put(cache, scope, "active", 1, 1_000)).toBe(true);
  expect(seen.agent).toEqual([expect.objectContaining({ from: "inactive", to: "active" })]);
  // Heartbeats and the same fact again change nothing.
  expect(await put(cache, scope, "active", 2, 2_000)).toBe(true);
  expect(await put(cache, scope, "active", 2, 2_000)).toBe(true);
  expect(seen.agent).toHaveLength(1);
  // A stale seq on the same instance is rejected and reports nothing.
  expect(await put(cache, scope, "inactive", 1, 3_000)).toBe(false);
  // A new instance with an older observation is rejected; a newer one is accepted.
  expect(await put(cache, scope, "inactive", 1, 500, "d2")).toBe(false);
  expect(seen.agent).toHaveLength(1);
  expect(await put(cache, scope, "inactive", 1, 4_000, "d2")).toBe(true);
  expect(seen.agent[1]).toMatchObject({ from: "active", to: "inactive" });
  // Inactive over inactive is nothing; inactive left the expiry index.
  expect(await put(cache, scope, "inactive", 2, 5_000, "d2")).toBe(true);
  expect(seen.agent).toHaveLength(2);
  const key = `coforge:workspace:${scope.workspaceId}:computer:${scope.computerId}:agent:${scope.agentId}:status:v2`;
  expect(await zscore(key)).toBeNull();
});

test("an expired Agent key reads as absent: the next active is inactive to active", async () => {
  const cache = agentCache();
  const scope = ids();
  await put(cache, scope, "active", 1, 1_000);
  const key = `coforge:workspace:${scope.workspaceId}:computer:${scope.computerId}:agent:${scope.agentId}:status:v2`;
  expect(await zscore(key)).toBeGreaterThan(Date.now());
  await Bun.sleep(1_200);
  await put(cache, scope, "active", 2, 3_000);
  expect(seen.agent).toEqual([
    expect.objectContaining({ from: "inactive", to: "active" }),
    expect.objectContaining({ from: "inactive", to: "active" }),
  ]);
});

test("Computer previous value: absent, offline, online, and the index follows", async () => {
  const cache = computerCache();
  const scope = { workspaceId: crypto.randomUUID(), computerId: crypto.randomUUID() };
  const key = `coforge:workspace:${scope.workspaceId}:computer:${scope.computerId}:status:v1`;
  await cache.put(scope, false);
  expect(seen.computer).toEqual([]);
  expect(await zscore(key)).toBeNull();
  await cache.put(scope, true);
  await cache.put(scope, true);
  expect(seen.computer).toEqual([expect.objectContaining({ from: "offline", to: "online" })]);
  expect(await zscore(key)).not.toBeNull();
  await cache.put(scope, false);
  expect(seen.computer[1]).toMatchObject({ from: "online", to: "offline" });
  expect(await zscore(key)).toBeNull();
  expect(await cache.get(scope)).toBe(false);
});

function sweeper(recorded: AppNotificationEvent[]) {
  const presence = new AppNotificationPresence({
    possible: () => true,
    workspace: async (id) => ({ id, slug: "s" }),
    record: async (_workspace, event) => void recorded.push(event),
  });
  return new PresenceSweep({
    redis,
    lock: { acquire: async () => true },
    observer: presence,
    possible: () => true,
    expiryKey,
  });
}

test("two racing sweeps emit a silent expiry once; a refreshed lease is not emitted", async () => {
  const agents = agentCache();
  const computers = computerCache();
  const lapsing = ids();
  const refreshed = ids();
  await put(agents, lapsing, "active", 1, 1_000);
  await computers.put(lapsing, true);
  await put(agents, refreshed, "active", 1, 1_000);
  await Bun.sleep(1_200);
  await put(agents, refreshed, "active", 2, 2_000);
  const recorded: AppNotificationEvent[] = [];
  await Promise.all([sweeper(recorded).tick(), sweeper(recorded).tick()]);
  await Bun.sleep(50);
  const mine = recorded.filter(
    (event) =>
      JSON.stringify(event.data).includes(lapsing.agentId) ||
      JSON.stringify(event.data).includes(lapsing.computerId),
  );
  expect(mine.map((event) => event.type).sort()).toEqual([
    "agent.status_changed",
    "computer.offline",
  ]);
  expect(mine.find((event) => event.type === "agent.status_changed")?.data).toMatchObject({
    agent_id: lapsing.agentId,
    from: "active",
    to: "inactive",
  });
  expect(JSON.stringify(recorded)).not.toContain(refreshed.agentId);
  // Claimed: a later tick finds nothing more.
  const again: AppNotificationEvent[] = [];
  await sweeper(again).tick();
  await Bun.sleep(50);
  expect(again).toEqual([]);
});

test("a live key with a stale score is left alone, not claimed", async () => {
  const cache = agentCache();
  const scope = ids();
  await put(cache, scope, "active", 1, 1_000);
  const key = `coforge:workspace:${scope.workspaceId}:computer:${scope.computerId}:agent:${scope.agentId}:status:v2`;
  await redis.send("ZADD", [expiryKey, "1", key]);
  const recorded: AppNotificationEvent[] = [];
  await sweeper(recorded).tick();
  await Bun.sleep(50);
  expect(JSON.stringify(recorded)).not.toContain(scope.agentId);
  // Its score moved to the key's real end (Redis's PTTL), so it neither emits nor stays due.
  const score = await zscore(key);
  expect(score).toBeGreaterThan(Date.now() - 5_000);
  expect(score).toBeLessThan(Date.now() + 2_000);
});

test("the sweep follows Redis's clock, not a skewed web clock", async () => {
  const agents = agentCache();
  const lapsing = ids();
  const live = ids();
  await put(agents, lapsing, "active", 1, 1_000);
  await Bun.sleep(1_200);
  const liveKey = `coforge:workspace:${live.workspaceId}:computer:${live.computerId}:agent:${live.agentId}:status:v2`;
  await put(
    new RedisAgentStatusCache(redis, { presence: observer, expiryKey, ttlSeconds: "60" }),
    live,
    "active",
    1,
    1_000,
  );
  const realNow = Date.now;
  const recorded: AppNotificationEvent[] = [];
  try {
    // A web clock a day ahead would call the live lease lapsed; a day behind, the lapsed one live.
    for (const skew of [86_400_000, -86_400_000]) {
      Date.now = () => realNow() + skew;
      await sweeper(recorded).tick();
    }
  } finally {
    Date.now = realNow;
  }
  await Bun.sleep(50);
  const text = JSON.stringify(recorded);
  expect(text).toContain(lapsing.agentId);
  expect(text).not.toContain(live.agentId);
  expect(await zscore(liveKey)).toBeGreaterThan(realNow());
});

test("a Computer's consecutive transitions never share an event id seed", async () => {
  const seeds: string[] = [];
  const computers = new RedisComputerStatusCache(redis, "60", {
    presence: { ...observer, computerPresence: (change) => void seeds.push(change.idSeed) },
    redis,
    expiryKey,
  });
  const scope = { workspaceId: crypto.randomUUID(), computerId: crypto.randomUUID() };
  for (let flip = 0; flip < 20; flip++) await computers.put(scope, flip % 2 === 0);
  expect(seeds).toHaveLength(20);
  expect(new Set(seeds).size).toBe(20);
});
