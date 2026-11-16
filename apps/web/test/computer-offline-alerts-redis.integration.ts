import { afterAll, describe, expect, test } from "bun:test";
import { RedisClient } from "bun";
import {
  ComputerOfflineAlertSweep,
  ComputerOfflineAlerts,
  COMPUTER_OFFLINE_ALERT_AFTER_MS,
  type ComputerOfflineAlertTarget,
  type ComputerOfflineRedis,
} from "#src/server/computers/computer-offline-alerts.server";

// The episode scripts, run by a real Redis: the unit fake reimplements their semantics, so only
// a real server can say the KEYS/ARGV order and the atomic marker+index writes are right.
const redisUrl = Bun.env.REDIS_URL;
if (!redisUrl) throw new Error("REDIS_URL must point to local Redis");

const client = new RedisClient(redisUrl);
const redis: ComputerOfflineRedis = {
  eval: (script, keys, ...args) => client.eval(script, keys, ...args),
  get: (key) => client.get(key),
  mget: (...keys) => client.mget(...keys),
  del: (...keys) => client.del(...keys),
  smembers: (key) => client.smembers(key),
  send: (command, args) => client.send(command, args),
};

const INDEX = "coforge:computer-offline:v1:index";
const markerKey = (computerId: string) => `coforge:computer-offline:v1:${computerId}`;

function presenceChange(computerId: string, to: "online" | "offline", observedAtMs: number) {
  return {
    workspaceId: "w1",
    computerId,
    from: to === "online" ? ("offline" as const) : ("online" as const),
    to,
    observedAtMs,
    idSeed: `seed-${computerId}-${to}`,
  };
}

async function waitFor<T>(read: () => Promise<T | null | undefined>, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== null && value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for Redis state");
    await Bun.sleep(10);
  }
}

afterAll(async () => {
  client.close();
});

describe("computer offline episodes against a real Redis", () => {
  test("the observer's episode write is atomic and first-report-wins", async () => {
    const computerId = `obs-${crypto.randomUUID()}`;
    const alerts = new ComputerOfflineAlerts({ possible: () => true, redis: () => redis });
    alerts.computerPresence(presenceChange(computerId, "offline", 1_111));
    expect(await waitFor(() => client.get(markerKey(computerId)))).toBe("1111");
    expect(await client.sismember(INDEX, computerId)).toBe(true);

    alerts.computerPresence(presenceChange(computerId, "offline", 9_999));
    await Bun.sleep(50);
    expect(await client.get(markerKey(computerId))).toBe("1111");

    alerts.computerPresence(presenceChange(computerId, "online", 2_222));
    await waitFor(async () => (await client.get(markerKey(computerId))) ?? "gone");
    expect(await client.sismember(INDEX, computerId)).toBe(false);
    await client.del(markerKey(computerId));
  });

  test("a sweep alerts once and its end script removes marker, index and claim", async () => {
    const computerId = `sweep-${crypto.randomUUID()}`;
    const offlineAt = 5_000;
    const alerts = new ComputerOfflineAlerts({ possible: () => true, redis: () => redis });
    alerts.computerPresence(presenceChange(computerId, "offline", offlineAt));
    await waitFor(() => client.get(markerKey(computerId)));

    const notified: number[] = [];
    const target: ComputerOfflineAlertTarget = {
      status: "ready",
      workspaceId: "w1",
      ownerId: "u1",
      computerName: "Studio",
      workspaceSlug: "lab",
      username: "frank",
    };
    const sweep = new ComputerOfflineAlertSweep({
      redis: () => redis,
      lock: { acquire: async () => true },
      possible: () => true,
      now: () => offlineAt + COMPUTER_OFFLINE_ALERT_AFTER_MS,
      resolve: async () => target,
      stillOnline: async () => false,
      notify: async (input) => {
        notified.push(input.offlineAtMs);
      },
    });
    await sweep.tick();
    await sweep.tick();
    expect(notified).toEqual([offlineAt]);
    expect(await client.get(markerKey(computerId))).toBeNull();
    expect(await client.sismember(INDEX, computerId)).toBe(false);
    expect(
      await client.get(`coforge:computer-offline-alert:v1:${computerId}:${offlineAt}`),
    ).toBeNull();
    await client.del(markerKey(computerId));
  });
});
