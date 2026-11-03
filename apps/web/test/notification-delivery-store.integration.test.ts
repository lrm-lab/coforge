import { afterAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { RedisClient } from "bun";

import { PrismaClient } from "#src/generated/prisma/client";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { RedisMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import { markHumanRead } from "#src/server/conversations/human-unread.server";
import {
  RedisComputerActivity,
  computerActivityKey,
} from "#src/server/notifications/computer-activity.server";
import { RedisDeferredPushes } from "#src/server/notifications/deferred-mobile-pushes.server";
import { NotificationSettingsStore } from "#src/server/notifications/notification-settings.server";
import { PrismaWebPushSubscriptionStore } from "#src/server/notifications/prisma-web-push-subscriptions.server";
import { quietCentrifugo } from "./helpers/fake-centrifugo";

/**
 * What the notification settings (task #467) read and write outside the rules, against local
 * PostgreSQL and Redis: whether a waiting phone notification's message was read (channel and
 * thread), the in-page notification following the settings, each device's last outcome, and the
 * Redis activity report and waiting queue. Skipped unless the channel test database and Redis are
 * set.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
const redisUrl = Bun.env.CHANNEL_TEST_REDIS_URL;
const db = connectionString
  ? new PrismaClient({ adapter: new PrismaPg({ connectionString }) })
  : undefined;
const redis = redisUrl ? new RedisClient(redisUrl) : undefined;
const ready = Boolean(db && redis);

afterAll(async () => {
  await db?.$disconnect();
  redis?.close();
});

async function scene() {
  const suffix = crypto.randomUUID().slice(0, 8);
  const alice = await db!.user.create({
    data: { displayName: `da${suffix}`, username: `da${suffix}` },
  });
  const bob = await db!.user.create({
    data: {
      displayName: `db${suffix}`,
      username: `db${suffix}`,
      preferences: { create: { browserNotificationsEnabled: true, timeZone: "UTC" } },
    },
  });
  const workspace = await db!.workspace.create({
    data: {
      slug: `notif-store-${suffix}`,
      name: "Notification store",
      members: { create: [{ userId: alice.id }, { userId: bob.id }] },
    },
  });
  const channels = new PublicChannels(
    db!,
    new RedisMessageRequestIdempotency(redis!),
    quietCentrifugo(),
  );
  const channelName = `notif-${suffix}`;
  const room = await channels.create(workspace.id, alice.id, channelName);
  await channels.join(workspace.id, bob.id, room.id);
  const send = (body: string, threadRootId?: string) =>
    channels.send({
      workspaceId: workspace.id,
      userId: alice.id,
      channelId: room.id,
      idempotencyKey: crypto.randomUUID(),
      body,
      ...(threadRootId && { threadRootId }),
    });
  return {
    alice,
    bob,
    room,
    channelName,
    send,
    store: new PrismaWebPushSubscriptionStore(db!),
    async cleanup() {
      await db!.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
      await db!.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } }).catch(() => {});
    },
  };
}

test.skipIf(!ready)(
  "a waiting notification knows when its message was read, in a channel and a thread",
  async () => {
    const s = await scene();
    try {
      const root = await s.send("ship it");
      const waiting = await s.store.deferredNotification(root.id, s.bob.id);
      expect(waiting).toMatchObject({
        title: `#${s.channelName}`,
        sender: expect.any(String),
        read: false,
      });
      expect(waiting?.recipient).toMatchObject({ userId: s.bob.id, timeZone: "UTC" });
      // A non-recipient (the sender) has nothing waiting.
      expect(await s.store.deferredNotification(root.id, s.alice.id)).toBeNull();

      const { sequence } = await db!.message.findUniqueOrThrow({
        where: { id: root.id },
        select: { sequence: true },
      });
      await markHumanRead(db!, {
        conversationId: s.room.id,
        userId: s.bob.id,
        throughSequence: sequence,
      });
      expect((await s.store.deferredNotification(root.id, s.bob.id))?.read).toBe(true);

      // A followed thread's reply is read through the thread's own read position.
      const member = await db!.conversationMember.findFirstOrThrow({
        where: { conversationId: s.room.id, userId: s.bob.id },
        select: { id: true, workspaceId: true },
      });
      await db!.threadFollow.create({
        data: {
          memberId: member.id,
          rootMessageId: root.id,
          conversationId: s.room.id,
          workspaceId: member.workspaceId,
        },
      });
      const reply = await s.send("on it", root.id);
      expect((await s.store.deferredNotification(reply.id, s.bob.id))?.read).toBe(false);
      const replySequence = (
        await db!.message.findUniqueOrThrow({ where: { id: reply.id }, select: { sequence: true } })
      ).sequence;
      await db!.threadRead.upsert({
        where: { memberId_rootMessageId: { memberId: member.id, rootMessageId: root.id } },
        create: {
          memberId: member.id,
          rootMessageId: root.id,
          conversationId: s.room.id,
          workspaceId: member.workspaceId,
          readThroughSequence: replySequence,
        },
        update: { readThroughSequence: replySequence },
      });
      expect((await s.store.deferredNotification(reply.id, s.bob.id))?.read).toBe(true);
    } finally {
      await s.cleanup();
    }
  },
);

test.skipIf(!ready)(
  "the in-page notification follows the settings: paused is nothing, hidden hides, silent",
  async () => {
    const s = await scene();
    try {
      const message = await s.send("ship it");
      const settings = new NotificationSettingsStore(db!);
      expect(await s.store.notificationForRecipient(message.id, s.bob.id)).toMatchObject({
        title: `#${s.channelName}`,
      });
      await settings.update(
        s.bob.id,
        { expectedVersion: 0, changes: { previewMode: "hidden", sound: false } },
        new Date(),
      );
      expect(await s.store.notificationForRecipient(message.id, s.bob.id)).toMatchObject({
        title: "CoForge",
        body: "New message",
        silent: true,
      });
      await settings.update(
        s.bob.id,
        {
          expectedVersion: 1,
          changes: { pausedUntil: new Date(Date.now() + 60_000).toISOString() },
        },
        new Date(),
      );
      expect(await s.store.notificationForRecipient(message.id, s.bob.id)).toBeNull();
    } finally {
      await s.cleanup();
    }
  },
);

test.skipIf(!ready)("each device keeps its kind, label and last outcome", async () => {
  const s = await scene();
  try {
    await s.store.saveSubscription(s.bob.id, {
      endpoint: `https://push.example/${crypto.randomUUID()}`,
      p256dh: "p",
      auth: "a",
      expirationTime: null,
      deviceKind: "mobile",
      deviceLabel: "Safari · iOS",
    });
    const [device] = await s.store.devicesForUser(s.bob.id);
    expect(device).toMatchObject({
      deviceKind: "mobile",
      deviceLabel: "Safari · iOS",
      lastSuccessAt: null,
    });
    const at = new Date("2026-11-03T10:00:00Z");
    await s.store.recordDeliveries([{ id: device!.id, ok: true, at }]);
    await s.store.recordDeliveries([{ id: device!.id, ok: false, at, reason: "unreachable" }]);
    expect((await s.store.devicesForUser(s.bob.id))[0]).toMatchObject({
      lastSuccessAt: at,
      lastFailureAt: at,
      lastFailureReason: "unreachable",
    });
  } finally {
    await s.cleanup();
  }
});

test.skipIf(!ready)(
  "a computer's activity report lives 150 seconds; the future is now",
  async () => {
    const activity = new RedisComputerActivity(redis!);
    const userId = crypto.randomUUID();
    const now = new Date();
    try {
      await activity.report(userId, new Date(now.getTime() + 60_000), now);
      expect((await activity.read([userId])).get(userId)).toEqual({
        lastInputAt: now,
        reportedAt: now,
      });
      const ttl = Number(await redis!.send("PTTL", [computerActivityKey(userId)]));
      expect(ttl).toBeGreaterThan(140_000);
      expect(ttl).toBeLessThanOrEqual(150_000);
      expect((await activity.read([crypto.randomUUID()])).size).toBe(0);
      // A second computer's report with older input never moves the person's last input back.
      const later = new Date(now.getTime() + 30_000);
      await activity.report(userId, new Date(now.getTime() - 120_000), later);
      expect((await activity.read([userId])).get(userId)).toEqual({
        lastInputAt: now,
        reportedAt: later,
      });
    } finally {
      await redis!.del(computerActivityKey(userId));
    }
  },
);

test.skipIf(!ready)(
  "the waiting queue is per person: due people once, their messages once",
  async () => {
    const prefix = `coforge:deferred-mobile-push:test:${crypto.randomUUID()}`;
    const queue = new RedisDeferredPushes(redis!, prefix);
    const now = new Date("2026-11-03T10:00:00Z");
    const alice = crypto.randomUUID();
    const bob = crypto.randomUUID();
    const first = { messageId: crypto.randomUUID(), userId: alice, firstQueuedAt: now };
    const second = {
      messageId: crypto.randomUUID(),
      userId: alice,
      firstQueuedAt: new Date(now.getTime() + 1_000),
    };
    try {
      await queue.defer(first, new Date(now.getTime() + 60_000));
      await queue.defer(second, new Date(now.getTime() + 60_000));
      await queue.defer(
        { messageId: crypto.randomUUID(), userId: bob, firstQueuedAt: now },
        new Date(now.getTime() + 600_000),
      );
      // The same message waiting again keeps when it first waited.
      await queue.defer(
        { ...first, firstQueuedAt: new Date(now.getTime() + 5_000) },
        new Date(now.getTime() + 60_000),
      );

      expect(await queue.takeDuePeople(10, now)).toEqual([]);
      expect(await queue.takeDuePeople(10, new Date(now.getTime() + 60_000))).toEqual([alice]);
      expect(await queue.takeDuePeople(10, new Date(now.getTime() + 60_000))).toEqual([]);
      // Looked at again later, Alice's messages stay until taken.
      await queue.reschedule(alice, new Date(now.getTime() + 90_000));
      expect(await queue.takeDuePeople(10, new Date(now.getTime() + 90_000))).toEqual([alice]);
      const taken = await queue.takeMessages(alice);
      expect(taken.sort((a, b) => a.firstQueuedAt.getTime() - b.firstQueuedAt.getTime())).toEqual([
        first,
        second,
      ]);
      expect(await queue.takeMessages(alice)).toEqual([]);
    } finally {
      await redis!.del(`${prefix}:due`, `${prefix}:person:${alice}`, `${prefix}:person:${bob}`);
    }
  },
);
