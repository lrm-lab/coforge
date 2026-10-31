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

test("a comment notification follows the file's read access, not the comment seat", async () => {
  const { attachmentCommentsFixture } = await import("./helpers/attachment-comments-fixture");
  const f = await attachmentCommentsFixture();
  try {
    // The private-channel repro: a commenter keeps their comment-conversation seat after the
    // source channel removes them (or turns private around them).
    await f.db.conversation.update({
      where: { id: f.conversation.id },
      data: { visibility: "private" },
    });
    await f.db.conversationMember.create({
      data: {
        conversationId: f.conversation.id,
        workspaceId: f.workspace.id,
        userId: f.viewer.id,
      },
    });
    for (const user of [f.member, f.viewer])
      await f.db.userPreference.upsert({
        where: { userId: user.id },
        create: { userId: user.id, browserNotificationsEnabled: true },
        update: { browserNotificationsEnabled: true },
      });
    // The comment conversation, its thread row, the three seats, one comment and its metadata.
    const discussion = await f.db.conversation.create({
      data: { workspaceId: f.workspace.id, kind: "attachment_comments" },
    });
    await f.db.attachmentCommentThread.create({
      data: {
        attachmentId: f.attachment.id,
        workspaceId: f.workspace.id,
        conversationId: discussion.id,
      },
    });
    const seat = (userId: string) =>
      f.db.conversationMember.create({
        data: { conversationId: discussion.id, workspaceId: f.workspace.id, userId },
        select: { id: true },
      });
    const [ownerSeat] = await Promise.all([seat(f.owner.id), seat(f.member.id), seat(f.viewer.id)]);
    const comment = await f.db.message.create({
      data: {
        conversationId: discussion.id,
        workspaceId: f.workspace.id,
        senderMemberId: ownerSeat.id,
        sequence: 1,
        body: "looks right",
      },
    });
    await f.db.attachmentComment.create({
      data: {
        attachmentId: f.attachment.id,
        workspaceId: f.workspace.id,
        conversationId: discussion.id,
        messageId: comment.id,
      },
    });
    const store = new PrismaWebPushSubscriptionStore(f.db);
    // Before the move: the seat carries both reads.
    expect(await store.notificationForRecipient(comment.id, f.member.id)).toMatchObject({
      conversationPath: `/w/${f.workspace.slug}/dm/${discussion.id}`,
    });
    // The file's channel removes the commenter; the seat stays.
    await f.db.conversationMember.update({
      where: {
        conversationId_userId: { conversationId: f.conversation.id, userId: f.member.id },
      },
      data: { leftAt: new Date() },
    });
    // By-id read: no longer a recipient, even though the seat still qualifies.
    expect(await store.notificationForRecipient(comment.id, f.member.id)).toBeNull();
    // The staying commenter still reads it.
    expect(await store.notificationForRecipient(comment.id, f.viewer.id)).not.toBeNull();
    // The broadcast to the comment's seats drops the leaver too.
    const pushed = await store.notificationForMessage(comment.id);
    expect(pushed?.recipients.map((row) => row.userId)).toEqual([f.viewer.id]);
  } finally {
    await f.close();
  }
});
