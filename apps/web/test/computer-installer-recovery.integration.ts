import { afterAll, expect, test } from "bun:test";
import { RedisClient } from "bun";
import {
  RedisComputerInstallerRecovery,
  type InstallerRecoveryConnection,
} from "#src/server/computers/computer-installer-recovery.server";
import {
  computerRestartIdentityKey,
  RedisComputerRestartStore,
} from "#src/server/computers/computer-restart-store.server";

const redisUrl = Bun.env.CHANNEL_TEST_REDIS_URL;
if (!redisUrl) throw new Error("CHANNEL_TEST_REDIS_URL must point to scratch Redis");
const redis = new RedisClient(redisUrl);
const keys = new Set<string>();
afterAll(async () => {
  if (keys.size) await redis.send("DEL", [...keys]);
  redis.close();
});

async function fixture() {
  const scope = { workspaceId: "installer-recovery-test", computerId: crypto.randomUUID() };
  const key = computerRestartIdentityKey(scope);
  keys.add(key);
  const restart = new RedisComputerRestartStore(redis);
  const current = {
    workerInstanceId: "worker",
    daemonVersion: "1.0.0",
    startedAt: 1,
    client: "connection-a",
    connectionSequence: 1,
  };
  const live = new Set([current.client]);
  const store = new RedisComputerInstallerRecovery(redis, async (_scope, identity) =>
    live.has(identity.client),
  );
  await restart.ready(scope, current, []);
  expect(await store.ready(scope, current)).toBe(true);
  const challenge = await store.observe(scope, current, { requestChallenge: true });
  expect(challenge).toBeDefined();
  const record = async () => JSON.parse((await redis.get(key))!);
  return { scope, current, store, restart, live, challenge: challenge!, record, key };
}

test("the current connection clears advice and can retrieve the next challenge after a lost reply", async () => {
  const f = await fixture();
  const first = { challenge: f.challenge.token, required: true, sampleSequence: 1 };
  const next = await f.store.observe(f.scope, f.current, first);
  expect(next?.generation).toBe(f.challenge.generation + 1);
  const positive = await f.record();
  expect((await f.store.read(f.scope))?.remainingMs).toBeGreaterThan(0);
  expect(await f.store.observe(f.scope, f.current, first)).toEqual(next);
  expect(await f.record()).toEqual(positive);

  const clear = { challenge: next!.token, required: false, sampleSequence: 2 };
  await f.store.observe(f.scope, f.current, clear);
  const cleared = await f.record();
  await f.store.observe(f.scope, f.current, first);
  expect(await f.store.read(f.scope)).toBeNull();
  expect(await f.record()).toEqual(cleared);
  expect(cleared.installerRecovery.sampleSequence).toBe(2);
});

test("expired evidence stays hidden until the same live connection collects a new challenge", async () => {
  const f = await fixture();
  const first = { challenge: f.challenge.token, required: true, sampleSequence: 1 };
  const expired = await f.store.observe(f.scope, f.current, first);
  const stored = await f.record();
  stored.installerRecovery.challengeIssuedAtMs = 1;
  stored.installerRecovery.visibleUntilMs = 1;
  await redis.set(f.key, JSON.stringify(stored));
  expect(await f.store.read(f.scope)).toBeNull();

  const challenge = await f.store.observe(f.scope, f.current, {
    challenge: expired!.token,
    required: true,
    sampleSequence: 3,
  });
  expect(challenge?.token).not.toBe(expired?.token);
  expect(await f.store.read(f.scope)).toBeNull();
  await f.store.observe(f.scope, f.current, {
    challenge: challenge!.token,
    required: true,
    sampleSequence: 4,
  });
  expect((await f.store.read(f.scope))?.remainingMs).toBeGreaterThan(0);
});

test("late ready, shutdown and samples cannot regain a newer or disconnected connection", async () => {
  const f = await fixture();
  const next: InstallerRecoveryConnection = {
    ...f.current,
    client: "connection-b",
    connectionSequence: 2,
  };
  f.live.add(next.client);
  expect(await f.store.ready(f.scope, next)).toBe(true);
  expect(await f.store.ready(f.scope, f.current)).toBe(false);
  await f.store.close(f.scope, f.current);
  expect(
    await f.store.observe(f.scope, f.current, {
      challenge: f.challenge.token,
      required: true,
      sampleSequence: 100,
    }),
  ).toBeUndefined();
  const challenge = await f.store.observe(f.scope, next, { requestChallenge: true });
  await f.store.observe(f.scope, next, {
    challenge: challenge!.token,
    required: true,
    sampleSequence: 1,
  });
  expect(await f.store.read(f.scope)).not.toBeNull();

  f.live.delete(next.client);
  expect(await f.store.read(f.scope)).toBeNull();
  const replacement = {
    ...next,
    workerInstanceId: "worker-b",
    startedAt: 2,
    client: "c",
    connectionSequence: 3,
  };
  f.live.add(replacement.client);
  await f.restart.ready(f.scope, { ...replacement, daemonVersion: "1.0.0" }, []);
  expect(await f.store.ready(f.scope, replacement)).toBe(true);
  expect(await f.store.observe(f.scope, next, { requestChallenge: true })).toBeUndefined();
  expect(await f.store.read(f.scope)).toBeNull();
});
