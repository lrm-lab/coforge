import { afterAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { RedisClient } from "bun";

import { PrismaClient } from "#src/generated/prisma/client";
import { RedisDeferredPushes } from "#src/server/notifications/deferred-mobile-pushes.server";
import { PrismaWebPushSubscriptionStore } from "#src/server/notifications/prisma-web-push-subscriptions.server";

const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
const redisUrl = Bun.env.CHANNEL_TEST_REDIS_URL;
if (!connectionString || !redisUrl)
  throw new Error("Notification protocol tests require PostgreSQL and Redis");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const redis = new RedisClient(redisUrl);

afterAll(async () => {
  await db.$disconnect();
  redis.close();
});

test("legacy sync preserves a binding and rotation is atomic and owner-scoped", async () => {
  const suffix = crypto.randomUUID();
  const previous = await db.user.create({
    data: { username: `old-${suffix}`, displayName: "Previous" },
  });
  const current = await db.user.create({
    data: { username: `new-${suffix}`, displayName: "Current" },
  });
  const store = new PrismaWebPushSubscriptionStore(db);
  const installation = crypto.randomUUID();
  const metadata = { p256dh: "key", auth: "auth", expirationTime: null };
  const endpoint = (part: string) => `https://push.example.test/${suffix}/${part}`;
  const save = (owner: string, part: string, installationId?: string) =>
    store.saveSubscription(owner, {
      ...metadata,
      endpoint: endpoint(part),
      browserInstallationId: installationId,
    });
  try {
    await save(previous.id, "old");
    expect((await store.subscriptionsForUser(previous.id))[0]?.browserInstallationId).toBeNull();
    await save(previous.id, "old", installation);
    await save(previous.id, "old");
    const old = (await store.subscriptionsForUser(previous.id))[0]!;
    expect(old.browserInstallationId).toBe(installation);

    await Promise.all([
      save(previous.id, "replacement-a", installation),
      save(previous.id, "replacement-b", installation.toUpperCase()),
    ]);
    const bound = await store.subscriptionsForUser(previous.id);
    expect(bound).toHaveLength(1);
    expect(bound[0]?.browserInstallationId).toBe(installation);
    const replacement = bound[0]!;
    expect(replacement.endpoint).not.toBe(old.endpoint);
    await store.removeSubscriptionById(old.id, old.endpoint);
    expect(await store.subscriptionsForUser(previous.id)).toHaveLength(1);

    await save(current.id, "unrelated", installation);
    expect((await store.subscriptionsForUser(current.id))[0]?.browserInstallationId).toBe(
      installation,
    );
    await store.saveSubscription(current.id, { ...metadata, endpoint: replacement.endpoint });
    await store.removeSubscriptionById(replacement.id, replacement.endpoint);
    expect(await store.subscriptionsForUser(previous.id)).toEqual([]);
    const taken = (await store.subscriptionsForUser(current.id)).find(
      (row) => row.endpoint === replacement.endpoint,
    );
    expect(taken?.browserInstallationId).toBeNull();
    expect(taken?.id).not.toBe(replacement.id);
  } finally {
    await db.user.deleteMany({ where: { id: { in: [previous.id, current.id] } } });
  }
});

test("legacy and scoped queue readers claim only their own records once", async () => {
  const prefix = `coforge:deferred-mobile-push:test:${crypto.randomUUID()}`;
  const legacy = new RedisDeferredPushes(redis, `${prefix}:legacy`);
  const scoped = new RedisDeferredPushes(redis, `${prefix}:scoped`, true);
  const now = new Date();
  const userId = crypto.randomUUID();
  const original = { messageId: crypto.randomUUID(), userId, firstQueuedAt: now };
  const selected = {
    ...original,
    messageId: crypto.randomUUID(),
    routes: [`installation:${crypto.randomUUID()}`],
  };
  await legacy.defer(original, now);
  await scoped.defer(selected, now);
  await scoped.defer({ ...selected, routes: [`installation:${crypto.randomUUID()}`] }, now);
  for (const [queue, entry] of [
    [legacy, original],
    [scoped, selected],
  ] as const) {
    const due = await Promise.all([queue.takeDuePeople(10, now), queue.takeDuePeople(10, now)]);
    expect(due.flat()).toEqual([userId]);
    expect(await queue.takeMessages(userId)).toEqual([entry]);
    expect(await queue.takeMessages(userId)).toEqual([]);
  }
});
