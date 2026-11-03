import { expect, test } from "bun:test";
import { enrollGeneral } from "./helpers/general-channel-fixture";
import { defaultMemoryAgentId } from "./helpers/default-memory-agent-fixture";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { RedisClient } from "bun";
import { RedisMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import { PrismaWorkspaceCatalogStore } from "#src/server/workspaces/catalog.server";
import { PrismaWorkspaceEnrollmentStore } from "#src/server/workspaces/enrollment.server";
import { readAuthorizedAttachment } from "#src/server/attachments/attachment.server";
import { PrismaWebPushSubscriptionStore } from "#src/server/notifications/prisma-web-push-subscriptions.server";
import { ConversationHistory } from "#src/server/conversations/conversation-history.server";
import type { MessageWebPushNotification } from "#src/server/notifications/web-push-notifications.server";

// Who sees #general and its history: Workspace members enrolled in it, never outsiders
// (moved from `public-channel.integration.ts`).

/** Flattens every recipient's browser subscriptions, matching the earlier assertions this
 * suite made directly against `notificationForMessage`'s old flat `subscriptions` field. */
function subscriptionsOf(notification: MessageWebPushNotification | null) {
  return notification?.recipients.flatMap((recipient) => recipient.subscriptions) ?? [];
}

test("Workspace humans enrolled in general see one general channel; outsiders cannot discover it", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const suffix = crypto.randomUUID();
  const alice = await db.user.create({
    data: { displayName: `alice-${suffix}`, username: `alice-${suffix}` },
  });
  const bob = await db.user.create({
    data: { displayName: `bob-${suffix}`, username: `bob-${suffix}` },
  });
  const outsider = await db.user.create({
    data: { displayName: `other-${suffix}`, username: `other-${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: suffix,
      name: "Channels",
      members: { create: [{ userId: alice.id }, { userId: bob.id }] },
    },
  });
  try {
    await enrollGeneral(db, workspace.id);
    await db.userPreference.createMany({
      data: [alice.id, bob.id].map((userId) => ({ userId, browserNotificationsEnabled: true })),
    });
    await db.webPushSubscription.createMany({
      data: [
        {
          userId: alice.id,
          endpoint: `https://fcm.googleapis.com/wp/alice-${suffix}`,
          p256dh: "a",
          auth: "a",
        },
        {
          userId: bob.id,
          endpoint: `https://fcm.googleapis.com/wp/bob-${suffix}`,
          p256dh: "b",
          auth: "b",
        },
      ],
    });
    const pushSubscriptions = new PrismaWebPushSubscriptionStore(db);
    const realtimeEvents: Array<{
      conversationId: string;
      messageId: string;
      sequence: number;
      workspaceId?: string;
      threadRootId?: string;
      idempotencyKey?: string;
      senderUserId?: string;
    }> = [];
    const channels = new PublicChannels(
      db,
      new RedisMessageRequestIdempotency(redis),
      undefined,
      undefined,
      {
        async memberChanged() {},
        async messageAvailable(event) {
          realtimeEvents.push(event);
        },
      },
    );
    const [first, second] = await Promise.all([
      channels.list(workspace.id, alice.id),
      channels.list(workspace.id, bob.id),
    ]);
    expect(first).toEqual([
      {
        id: expect.any(String),
        name: "general",
        joined: true,
        archived: false,
        visibility: "public",
        muted: false,
        notificationLevel: "all",
        unreadCount: 0,
        mentioned: false,
        lastMessage: null,
        members: expect.any(Array),
        hidden: false,
        pinned: false,
        pinSortOrder: null,
      },
    ]);
    expect(second).toEqual(first);
    expect(await channels.list(workspace.id, alice.id)).toEqual(first);
    await expect(channels.list(workspace.id, outsider.id)).rejects.toThrow("ACCESS_DENIED");
    const engineering = await channels.create(workspace.id, alice.id, "engineering");
    expect(
      (await channels.list(workspace.id, bob.id)).find((c) => c.name === "engineering")?.joined,
    ).toBe(false);
    expect((await channels.open(workspace.id, bob.id, engineering.id)).senderMemberId).toBe("");
    await expect(channels.open(workspace.id, outsider.id, engineering.id)).rejects.toThrow(
      "ACCESS_DENIED",
    );
    await expect(channels.create(workspace.id, outsider.id, "secret")).rejects.toThrow(
      "ACCESS_DENIED",
    );
    // Any Workspace member (bob, a plain member) can create a channel.
    const memberChannel = await channels.create(workspace.id, bob.id, "member-channel");
    expect(memberChannel.id).toEqual(expect.any(String));
    await expect(channels.join(workspace.id, outsider.id, engineering.id)).rejects.toThrow(
      "ACCESS_DENIED",
    );
    await expect(channels.create(workspace.id, alice.id, "engineering")).rejects.toThrow(
      "CONFLICT",
    );
    await expect(channels.create(workspace.id, alice.id, "bad:name")).rejects.toThrow();
    const send = (userId: string, body: string, idempotencyKey = crypto.randomUUID()) =>
      channels.send({
        workspaceId: workspace.id,
        userId,
        channelId: engineering.id,
        body,
        idempotencyKey,
      });
    await expect(send(bob.id, "not joined")).rejects.toThrow("ACCESS_DENIED");
    await expect(send(outsider.id, "not in workspace")).rejects.toThrow("ACCESS_DENIED");
    const idempotencyKey = crypto.randomUUID();
    const attachment = await db.attachment.create({
      data: {
        workspaceId: workspace.id,
        conversationId: engineering.id,
        uploaderId: alice.id,
        objectKey: `test/${suffix}`,
        fileName: "notes.txt",
        contentType: "text/plain",
        sizeBytes: 5,
      },
    });
    await expect(
      readAuthorizedAttachment(db, {
        attachmentId: attachment.id,
        userId: bob.id,
      }),
    ).rejects.toThrow("NOT_FOUND");
    const saved = await channels.send({
      workspaceId: workspace.id,
      userId: alice.id,
      channelId: engineering.id,
      idempotencyKey,
      body: "Hello Bob",
      attachmentIds: [attachment.id],
    });
    expect(subscriptionsOf(await pushSubscriptions.notificationForMessage(saved.id))).toEqual([]);
    expect(realtimeEvents).toContainEqual({
      conversationId: engineering.id,
      messageId: saved.id,
      sequence: saved.sequence,
      workspaceId: workspace.id,
      threadRootId: undefined,
      idempotencyKey,
      // Alice's own message: her other pages do not count it unread.
      senderUserId: alice.id,
    });
    expect((await send(alice.id, "Hello Bob", idempotencyKey)).id).toBe(saved.id);
    const unjoined = await channels.open(workspace.id, bob.id, engineering.id);
    expect(unjoined.messages.map((m) => m.body)).toEqual(["Hello Bob"]);
    expect(
      (
        await readAuthorizedAttachment(db, {
          attachmentId: attachment.id,
          userId: bob.id,
        })
      ).attachment.id,
    ).toBe(attachment.id);
    await expect(
      readAuthorizedAttachment(db, {
        attachmentId: attachment.id,
        userId: outsider.id,
      }),
    ).rejects.toThrow("ACCESS_DENIED");
    await Promise.all([
      channels.join(workspace.id, bob.id, engineering.id),
      channels.join(workspace.id, bob.id, engineering.id),
    ]);
    expect(await channels.setUserMuted(workspace.id, bob.id, engineering.id, true)).toEqual({
      muted: true,
    });
    const mutedChannel = await channels.open(workspace.id, bob.id, engineering.id);
    expect(mutedChannel.senderMemberId).not.toBe("");
    expect(mutedChannel.muted).toBeTrue();
    expect(subscriptionsOf(await pushSubscriptions.notificationForMessage(saved.id))).toEqual([]);
    const mutedOrdinary = await send(alice.id, "Muted ordinary message");
    expect(
      subscriptionsOf(await pushSubscriptions.notificationForMessage(mutedOrdinary.id)),
    ).toEqual([]);
    // notificationForRecipient shares the same recipient rule, narrowed to one already-known user
    // (the seam `getMessageNotification` reads): muted bob is not a recipient of the ordinary
    // message, and the sender is never their own recipient either.
    expect(await pushSubscriptions.notificationForRecipient(mutedOrdinary.id, bob.id)).toBeNull();
    expect(await pushSubscriptions.notificationForRecipient(mutedOrdinary.id, alice.id)).toBeNull();
    const mutedMention = await send(alice.id, `@${bob.username} please review this`);
    const mentionNotification = await pushSubscriptions.notificationForMessage(mutedMention.id);
    // Muted means no push even when @mentioned; the mention still shows as a badge.
    expect(subscriptionsOf(mentionNotification)).toEqual([]);
    // The target names the Chat tab: a member's own tab order can put another tab first.
    expect(mentionNotification?.url).toBe(
      `/notifications/open?workspace=${workspace.slug}&target=${encodeURIComponent(`/w/${workspace.slug}/channel/${engineering.id}?view=chat#message-${mutedMention.id}`)}`,
    );
    // A muted member's push stays off even when @mentioned; only the badge shows.
    expect(await pushSubscriptions.notificationForRecipient(mutedMention.id, bob.id)).toBeNull();
    expect(await pushSubscriptions.notificationForRecipient(mutedMention.id, alice.id)).toBeNull();
    await channels.setUserMuted(workspace.id, bob.id, engineering.id, false);
    expect(subscriptionsOf(await pushSubscriptions.notificationForMessage(saved.id))).toEqual([
      expect.objectContaining({
        endpoint: `https://fcm.googleapis.com/wp/bob-${suffix}`,
      }),
    ]);
    await send(bob.id, "Hello Alice");
    const history = await channels.open(workspace.id, alice.id, engineering.id);
    // `senderName` is the display name a person reads (falling back to the username), not the
    // `@handle` — the handle travels beside it as `senderHandle`, which is what a mention types.
    expect(history.messages.map((m) => [m.sequence, m.senderName, m.senderHandle, m.body])).toEqual(
      [
        [1, alice.username, alice.username, "Hello Bob"],
        [2, alice.username, alice.username, "Muted ordinary message"],
        // A resolved mention is stored as an embedded-UUID token (PR #338) and carries a
        // MessageMention row; the browser renders the handle from that row, never by re-parsing
        // prose. `agentReadableBody` is what turns the token back into `@handle` for Agents.
        [3, alice.username, alice.username, `<@human:${bob.id}> please review this`],
        [4, bob.username, bob.username, "Hello Alice"],
      ],
    );
    // The token is resolved, not orphaned: the viewer gets the mention row it renders from. The
    // projection's `kind` is `user` (the browser's sender vocabulary); the token's prefix is
    // `human`.
    expect(history.messages[2]?.mentions).toEqual([
      {
        kind: "user",
        actorId: bob.id,
        handle: bob.username,
        label: bob.username,
      },
    ]);
    expect(history.messages[0]?.mentions).toEqual([]);
    expect(history.messages[0]?.senderMemberId).toBe(history.senderMemberId);
    expect(history.messages[3]?.senderMemberId).not.toBe(history.senderMemberId);
    await Promise.all([send(alice.id, "Concurrent A"), send(bob.id, "Concurrent B")]);
    const concurrentHistory = await channels.open(workspace.id, alice.id, engineering.id);
    expect(concurrentHistory.messages.map((m) => m.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    const concurrentBobMessage = concurrentHistory.messages.find(
      (message) => message.body === "Concurrent B",
    );
    expect(concurrentBobMessage?.senderMemberId).not.toBe(concurrentHistory.senderMemberId);
    const browserHistory = new ConversationHistory(db);
    expect(
      (await browserHistory.listOwnMessages(workspace.id, alice.id, engineering.id)).messages.map(
        (message) => message.body,
      ),
    ).toEqual([
      "Hello Bob",
      "Muted ordinary message",
      // Same stored-token contract as above.
      `<@human:${bob.id}> please review this`,
      "Concurrent A",
    ]);
    // A jump lands on another member's message too (#740): for a channel, Workspace membership is
    // the whole access decision, so Bob opens the window around Alice's message and an outsider
    // is refused.
    expect(
      (
        await browserHistory.loadAround(workspace.id, bob.id, engineering.id, saved.id)
      ).messages.some((message) => message.id === saved.id),
    ).toBe(true);
    await expect(
      browserHistory.loadAround(workspace.id, outsider.id, engineering.id, saved.id),
    ).rejects.toThrow("ACCESS_DENIED");
    await expect(
      browserHistory.listOwnMessages(workspace.id, outsider.id, engineering.id),
    ).rejects.toThrow("ACCESS_DENIED");
    const latestPage = await channels.open(workspace.id, alice.id, engineering.id, { limit: 2 });
    expect(latestPage.hasOlder).toBe(true);
    // The initial (uncursored) page is the live tail: nothing newer to fetch.
    expect(latestPage.hasNewer).toBe(false);
    expect(latestPage.messages.map((message) => message.sequence)).toEqual([5, 6]);
    const olderPage = await channels.open(workspace.id, alice.id, engineering.id, {
      beforeSequence: 5,
      limit: 2,
    });
    expect(olderPage.hasOlder).toBe(true);
    // A backward page always has newer content above it, so the bounded window knows the tail it
    // retained is no longer the live end.
    expect(olderPage.hasNewer).toBe(true);
    expect(olderPage.messages.map((message) => message.sequence)).toEqual([3, 4]);
    // Reading back towards the live end from the retained page recovers the tail.
    const newerPage = await channels.open(workspace.id, alice.id, engineering.id, {
      afterSequence: 4,
      limit: 2,
    });
    expect(newerPage.hasOlder).toBe(true);
    expect(newerPage.hasNewer).toBe(false);
    expect(newerPage.messages.map((message) => message.sequence)).toEqual([5, 6]);
    expect(
      (await channels.updates(workspace.id, alice.id, engineering.id, 4)).map(
        (message) => message.sequence,
      ),
    ).toEqual([5, 6]);
    const direct = await db.conversation.create({
      data: { workspaceId: workspace.id, directKey: `private-${suffix}` },
    });
    await expect(channels.open(workspace.id, bob.id, direct.id)).rejects.toThrow("NOT_FOUND");
    await expect(channels.join(workspace.id, bob.id, direct.id)).rejects.toThrow("NOT_FOUND");
    await db.workspaceMembership.delete({
      where: {
        workspaceId_userId: { workspaceId: workspace.id, userId: bob.id },
      },
    });
    await expect(channels.open(workspace.id, bob.id, engineering.id)).rejects.toThrow(
      "ACCESS_DENIED",
    );
    await expect(send(bob.id, "membership revoked")).rejects.toThrow("ACCESS_DENIED");
    await expect(
      readAuthorizedAttachment(db, {
        attachmentId: attachment.id,
        userId: bob.id,
      }),
    ).rejects.toThrow("ACCESS_DENIED");
    for (const store of [
      new PrismaWorkspaceCatalogStore(db),
      new PrismaWorkspaceEnrollmentStore(db),
    ]) {
      const created = await store.createForUser({
        slug: crypto.randomUUID(),
        name: "New workspace",
        userId: alice.id,
        locale: "en",
      });
      const id = typeof created === "string" ? created : created.id;
      try {
        // Workspace creation itself creates #general with its creator in it; reads never enroll.
        const createdGeneral = await db.conversation.findFirst({
          where: { workspaceId: id, channelName: "general" },
          include: { members: true },
        });
        expect(createdGeneral?.members.map((m) => m.userId ?? m.agentId).sort()).toEqual(
          [alice.id, await defaultMemoryAgentId(db, id)].sort(),
        );
      } finally {
        await db.workspace.delete({ where: { id } });
      }
    }
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.deleteMany({
      where: { id: { in: [alice.id, bob.id, outsider.id] } },
    });
    await db.$disconnect();
    redis.close();
  }
});
