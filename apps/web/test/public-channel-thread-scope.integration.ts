import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { RedisClient } from "bun";
import { RedisMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { PrismaWebPushSubscriptionStore } from "#src/server/notifications/prisma-web-push-subscriptions.server";
import { ConversationHistory } from "#src/server/conversations/conversation-history.server";
import { enrollGeneral } from "./helpers/general-channel-fixture";
import { unfollowAgentThread } from "#src/server/agents/agent-messages.server";
import { recordingDeliveries } from "./helpers/fake-centrifugo";
import { subscriptionsOf } from "./helpers/public-channel-helpers";

test("channel threads enforce channel scope and isolate reads, recovery, notifications, and attachments", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const suffix = crypto.randomUUID();
  const alice = await db.user.create({
    data: { displayName: `ta${suffix.slice(0, 8)}`, username: `ta${suffix.slice(0, 8)}` },
  });
  const bob = await db.user.create({
    data: { displayName: `tb${suffix.slice(0, 8)}`, username: `tb${suffix.slice(0, 8)}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `thread-${suffix}`,
      name: "Channel threads",
      members: { create: [{ userId: alice.id }, { userId: bob.id }] },
    },
  });
  const foreignWorkspace = await db.workspace.create({
    data: {
      slug: `foreign-${suffix}`,
      name: "Foreign channel threads",
      members: { create: { userId: alice.id } },
    },
  });
  try {
    const computer = await db.computer.create({
      data: { ownerId: alice.id, machineId: crypto.randomUUID() },
    });
    const agent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: alice.id,
        computerId: computer.id,
        name: "thread-helper",
        displayName: "Thread Helper",
        runtimeConfig: {},
      },
    });
    await enrollGeneral(db, workspace.id);
    await enrollGeneral(db, foreignWorkspace.id);
    const { publisher, delivered: published } = recordingDeliveries();
    const channels = new PublicChannels(db, new RedisMessageRequestIdempotency(redis), publisher);
    const general = await channels.create(workspace.id, alice.id, "threads");
    await db.conversationMember.create({
      data: { workspaceId: workspace.id, conversationId: general.id, agentId: agent.id },
    });
    const foreignGeneral = (await channels.list(foreignWorkspace.id, alice.id))[0]!;
    const foreignRoot = await channels.send({
      workspaceId: foreignWorkspace.id,
      userId: alice.id,
      channelId: foreignGeneral.id,
      idempotencyKey: crypto.randomUUID(),
      body: "foreign root",
    });
    const root = await channels.send({
      workspaceId: workspace.id,
      userId: alice.id,
      channelId: general.id,
      idempotencyKey: crypto.randomUUID(),
      body: "channel root",
    });
    await channels.setAgentMuted(workspace.id, agent.id, "#threads", true);
    const quietReply = await channels.send({
      workspaceId: workspace.id,
      userId: alice.id,
      channelId: general.id,
      idempotencyKey: crypto.randomUUID(),
      body: "quiet thread reply",
      threadRootId: root.id,
    });
    const mentionedReply = await channels.send({
      workspaceId: workspace.id,
      userId: alice.id,
      channelId: general.id,
      idempotencyKey: crypto.randomUUID(),
      body: "@thread-helper please inspect this thread",
      threadRootId: root.id,
    });
    const target = `#threads:${root.id}`;
    const repo = new PrismaDirectConversationRepository(db);
    expect(published.map((message) => [message.messageId, message.target])).toEqual([
      [root.id, "#threads"],
      [mentionedReply.id, target],
    ]);
    const followedReply = await channels.send({
      workspaceId: workspace.id,
      userId: alice.id,
      channelId: general.id,
      idempotencyKey: crypto.randomUUID(),
      body: "ordinary reply reaches a follower through channel mute",
      threadRootId: root.id,
    });
    expect(published.at(-1)?.messageId).toBe(followedReply.id);
    await unfollowAgentThread(repo, { workspaceId: workspace.id, agentId: agent.id }, target);
    const afterUnfollow = await channels.send({
      workspaceId: workspace.id,
      userId: alice.id,
      channelId: general.id,
      idempotencyKey: crypto.randomUUID(),
      body: "ordinary reply after unfollow",
      threadRootId: root.id,
    });
    expect(published.some((message) => message.messageId === afterUnfollow.id)).toBe(false);
    const reactivatingMention = await channels.send({
      workspaceId: workspace.id,
      userId: alice.id,
      channelId: general.id,
      idempotencyKey: crypto.randomUUID(),
      body: "@thread-helper please return",
      threadRootId: root.id,
    });
    const afterReactivation = await channels.send({
      workspaceId: workspace.id,
      userId: alice.id,
      channelId: general.id,
      idempotencyKey: crypto.randomUUID(),
      body: "ordinary reply after mention restored follow",
      threadRootId: root.id,
    });
    expect(published.slice(-2).map((message) => message.messageId)).toEqual([
      reactivatingMention.id,
      afterReactivation.id,
    ]);
    await expect(
      channels.send({
        workspaceId: workspace.id,
        userId: bob.id,
        channelId: general.id,
        idempotencyKey: crypto.randomUUID(),
        body: "not joined",
        threadRootId: root.id,
      }),
    ).rejects.toThrow("ACCESS_DENIED");
    await expect(
      channels.send({
        workspaceId: workspace.id,
        userId: alice.id,
        channelId: general.id,
        idempotencyKey: crypto.randomUUID(),
        body: "cross Workspace root",
        threadRootId: foreignRoot.id,
      }),
    ).rejects.toThrow("not found");
    await expect(
      channels.send({
        workspaceId: workspace.id,
        userId: alice.id,
        channelId: general.id,
        idempotencyKey: crypto.randomUUID(),
        body: "nested thread",
        threadRootId: quietReply.id,
      }),
    ).rejects.toThrow("top-level");
    const attachment = await db.attachment.create({
      data: {
        workspaceId: workspace.id,
        conversationId: general.id,
        uploaderId: alice.id,
        objectKey: `channel-thread/${suffix}`,
        fileName: "thread.txt",
        contentType: "text/plain",
        sizeBytes: 6,
      },
    });
    const attachmentReply = await channels.send({
      workspaceId: workspace.id,
      userId: alice.id,
      channelId: general.id,
      idempotencyKey: crypto.randomUUID(),
      body: "thread attachment",
      attachmentIds: [attachment.id],
      threadRootId: root.id,
    });
    expect(
      (await repo.readMessages(workspace.id, agent.id, "#threads", { unread: true })).map(
        (m) => m.id,
      ),
    ).toEqual([root.id]);
    expect(
      (
        await repo.readMessages(workspace.id, agent.id, `#threads:${root.id}`, { unread: true })
      ).map((message) => [message.id, message.target, message.attachments.at(0)?.id]),
    ).toEqual([
      [quietReply.id, target, undefined],
      [mentionedReply.id, target, undefined],
      [followedReply.id, target, undefined],
      [afterUnfollow.id, target, undefined],
      [reactivatingMention.id, target, undefined],
      [afterReactivation.id, target, undefined],
      [attachmentReply.id, target, attachment.id],
    ]);
    expect((await repo.readAgentRecoveryContext(workspace.id, agent.id)).unreadSummary).toEqual({});
    await repo.setAgentThreadFollowed(workspace.id, agent.id, target, false);
    const agentReply = await repo.sendAgentMessage(
      general.id,
      agent.id,
      "Agent thread response",
      undefined,
      root.id,
    );
    expect(agentReply.target).toBe(target);
    expect(
      await db.threadFollow.findUnique({
        where: {
          memberId_rootMessageId: {
            memberId: (
              await db.conversationMember.findUniqueOrThrow({
                where: {
                  conversationId_agentId: { conversationId: general.id, agentId: agent.id },
                },
              })
            ).id,
            rootMessageId: root.id,
          },
        },
      }),
    ).not.toBeNull();
    expect(
      (await repo.readPendingAgentDeliveries(workspace.id, agent.id)).some(
        (message) => message.messageId === agentReply.id,
      ),
    ).toBe(false);
    const opened = await channels.open(workspace.id, bob.id, general.id);
    // The window holds the root, the thread's unfollow records, and its summary; the replies come
    // with the thread read.
    const unfollowRecords = await db.message.findMany({
      where: { conversationId: general.id, body: { startsWith: "@Thread Helper unfollowed" } },
      orderBy: { sequence: "asc" },
      select: { id: true },
    });
    expect(unfollowRecords).toHaveLength(2);
    expect(opened.messages.map((message) => message.id)).toEqual([
      root.id,
      ...unfollowRecords.map((record) => record.id),
    ]);
    expect(opened.threads[root.id]).toMatchObject({
      replyCount: 8,
      lastReplySequence: agentReply.sequence,
    });
    const thread = await new ConversationHistory(db).loadThread(
      workspace.id,
      bob.id,
      general.id,
      root.id,
    );
    expect(thread.replies.map((message) => message.id)).toEqual([
      quietReply.id,
      mentionedReply.id,
      followedReply.id,
      afterUnfollow.id,
      reactivatingMention.id,
      afterReactivation.id,
      attachmentReply.id,
      agentReply.id,
    ]);
    expect(opened.threadReadThrough[root.id]).toBeUndefined();
    await channels.markThreadReadForUser(workspace.id, alice.id, general.id, root.id, 999);
    expect(
      (await channels.open(workspace.id, alice.id, general.id)).threadReadThrough[root.id],
    ).toBe(agentReply.sequence);
    expect(
      (await channels.open(workspace.id, alice.id, general.id)).followedThreadRootIds,
    ).toContain(root.id);
    await channels.setUserThreadFollowed(workspace.id, alice.id, general.id, root.id, false);
    expect(
      (await channels.open(workspace.id, alice.id, general.id)).followedThreadRootIds,
    ).not.toContain(root.id);
    await channels.join(workspace.id, bob.id, general.id);
    await db.userPreference.create({
      data: { userId: bob.id, browserNotificationsEnabled: true },
    });
    await db.webPushSubscription.create({
      data: {
        userId: bob.id,
        endpoint: `https://fcm.googleapis.com/wp/channel-thread-${suffix}`,
        p256dh: "thread-key",
        auth: "thread-auth",
      },
    });
    await channels.send({
      workspaceId: workspace.id,
      userId: bob.id,
      channelId: general.id,
      idempotencyKey: crypto.randomUUID(),
      body: "Bob participates and follows",
      threadRootId: root.id,
    });
    await channels.setUserMuted(workspace.id, bob.id, general.id, true);
    const followerNotice = await channels.send({
      workspaceId: workspace.id,
      userId: alice.id,
      channelId: general.id,
      idempotencyKey: crypto.randomUUID(),
      body: "ordinary human follower notification",
      threadRootId: root.id,
    });
    const pushSubscriptions = new PrismaWebPushSubscriptionStore(db);
    // Muted: no push.
    expect(
      subscriptionsOf(await pushSubscriptions.notificationForMessage(followerNotice.id)),
    ).toEqual([]);
    await channels.setUserThreadFollowed(workspace.id, bob.id, general.id, root.id, false);
    const unfollowedNotice = await channels.send({
      workspaceId: workspace.id,
      userId: alice.id,
      channelId: general.id,
      idempotencyKey: crypto.randomUUID(),
      body: "quiet after human unfollow",
      threadRootId: root.id,
    });
    expect(
      subscriptionsOf(await pushSubscriptions.notificationForMessage(unfollowedNotice.id)),
    ).toEqual([]);

    // An Agent's first reply enrolls the root author, while a later reply respects that author's
    // explicit unfollow just as the human send path does.
    const agentOnlyRoot = await channels.send({
      workspaceId: workspace.id,
      userId: alice.id,
      channelId: general.id,
      idempotencyKey: crypto.randomUUID(),
      body: "agent-only root",
    });
    await repo.sendAgentMessage(
      general.id,
      agent.id,
      "first Agent reply",
      undefined,
      agentOnlyRoot.id,
    );
    const aliceMember = await db.conversationMember.findFirstOrThrow({
      where: { conversationId: general.id, userId: alice.id },
      select: { id: true },
    });
    expect(
      await db.threadFollow.findUnique({
        where: {
          memberId_rootMessageId: {
            memberId: aliceMember.id,
            rootMessageId: agentOnlyRoot.id,
          },
        },
      }),
    ).not.toBeNull();
    await channels.setUserThreadFollowed(
      workspace.id,
      alice.id,
      general.id,
      agentOnlyRoot.id,
      false,
    );
    await repo.sendAgentMessage(
      general.id,
      agent.id,
      "second Agent reply",
      undefined,
      agentOnlyRoot.id,
    );
    expect(
      await db.threadFollow.findUnique({
        where: {
          memberId_rootMessageId: {
            memberId: aliceMember.id,
            rootMessageId: agentOnlyRoot.id,
          },
        },
      }),
    ).toBeNull();
  } finally {
    await db.workspace.deleteMany({ where: { id: { in: [workspace.id, foreignWorkspace.id] } } });
    await db.computer.deleteMany({ where: { ownerId: alice.id } });
    await db.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
    await db.$disconnect();
    redis.close();
  }
});
