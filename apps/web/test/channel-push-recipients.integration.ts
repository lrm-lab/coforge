import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { RedisClient } from "bun";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { RedisMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import { PrismaWebPushSubscriptionStore } from "#src/server/notifications/prisma-web-push-subscriptions.server";
import { quietCentrifugo } from "./helpers/fake-centrifugo";

test("a channel member without a browser push subscription is still a notificationForMessage recipient", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const suffix = crypto.randomUUID().slice(0, 8);
  const alice = await db.user.create({
    data: { displayName: `na${suffix}`, username: `na${suffix}` },
  });
  // Notifications enabled, but this user never registered a browser subscription — the in-page
  // path must still treat them as a recipient so a later realtime signal reaches them,
  // even though the old flat `subscriptions` field would have silently dropped them.
  const carol = await db.user.create({
    data: {
      displayName: `nc${suffix}`,
      username: `nc${suffix}`,
      preferences: { create: { browserNotificationsEnabled: true } },
    },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `no-subscription-${suffix}`,
      name: "No subscription",
      members: { create: [{ userId: alice.id }, { userId: carol.id }] },
    },
  });
  try {
    const channels = new PublicChannels(
      db,
      new RedisMessageRequestIdempotency(redis),
      quietCentrifugo(),
    );
    const room = await channels.create(workspace.id, alice.id, "no-subscription");
    await channels.join(workspace.id, carol.id, room.id);
    const message = await channels.send({
      workspaceId: workspace.id,
      userId: alice.id,
      channelId: room.id,
      idempotencyKey: crypto.randomUUID(),
      body: "hello without a subscription",
    });
    const pushSubscriptions = new PrismaWebPushSubscriptionStore(db);
    const notification = await pushSubscriptions.notificationForMessage(message.id);
    expect(notification?.workspaceId).toBe(workspace.id);
    expect(notification?.recipients).toEqual([{ userId: carol.id, subscriptions: [] }]);
    expect(await pushSubscriptions.notificationForRecipient(message.id, carol.id)).toEqual({
      title: notification!.title,
      body: notification!.body,
      url: notification!.url,
      tag: `message:${message.id}`,
      conversationPath: `/w/${workspace.slug}/channel/${room.id}`,
    });
  } finally {
    await db.workspace.deleteMany({ where: { id: workspace.id } });
    await db.user.deleteMany({ where: { id: { in: [alice.id, carol.id] } } });
    await db.$disconnect();
    redis.close();
  }
});
