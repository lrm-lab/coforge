import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { RedisClient } from "bun";
import { RedisMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import { PrismaWebPushSubscriptionStore } from "#src/server/notifications/prisma-web-push-subscriptions.server";
import { quietCentrifugo } from "./helpers/fake-centrifugo";

test("a mention pierces a muted member's push only through the message's stored mention rows; an @handle in code or a link label does not", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const suffix = crypto.randomUUID().slice(0, 8);
  const alice = await db.user.create({
    data: { displayName: `pa${suffix}`, username: `pa${suffix}` },
  });
  const bob = await db.user.create({
    data: {
      displayName: `pb${suffix}`,
      username: `pb${suffix}`,
      preferences: { create: { browserNotificationsEnabled: true } },
    },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `mute-pierce-${suffix}`,
      name: "Mute pierce",
      members: { create: [{ userId: alice.id }, { userId: bob.id }] },
    },
  });
  try {
    const channels = new PublicChannels(
      db,
      new RedisMessageRequestIdempotency(redis),
      quietCentrifugo(),
    );
    const room = await channels.create(workspace.id, alice.id, "mute-pierce");
    await channels.join(workspace.id, bob.id, room.id);
    await channels.setUserMuted(workspace.id, bob.id, room.id, true);
    const send = (body: string) =>
      channels.send({
        workspaceId: workspace.id,
        userId: alice.id,
        channelId: room.id,
        idempotencyKey: crypto.randomUUID(),
        body,
      });
    const pushSubscriptions = new PrismaWebPushSubscriptionStore(db);
    const recipientsOf = async (messageId: string) =>
      (await pushSubscriptions.notificationForMessage(messageId))?.recipients.map(
        (recipient) => recipient.userId,
      );

    const mentioned = await send(`@${bob.username} please review`);
    // Muted means no push even when @mentioned; the mention still shows as a badge.
    expect(await recipientsOf(mentioned.id)).toEqual([]);
    expect(await pushSubscriptions.notificationForRecipient(mentioned.id, bob.id)).toBeNull();

    const notMentioned = await send(
      `see \`@${bob.username}\` and [ask @${bob.username}](https://example.com)`,
    );
    expect(await db.messageMention.count({ where: { messageId: notMentioned.id } })).toBe(0);
    expect(await recipientsOf(notMentioned.id)).toEqual([]);
    expect(await pushSubscriptions.notificationForRecipient(notMentioned.id, bob.id)).toBeNull();
  } finally {
    await db.workspace.deleteMany({ where: { id: workspace.id } });
    await db.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
    await db.$disconnect();
    redis.close();
  }
});
