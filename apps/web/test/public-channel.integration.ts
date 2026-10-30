import "./channel-reference-agent-reads.integration";
import { defaultMemoryAgentId } from "./helpers/default-memory-agent-fixture";
import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { enrollGeneralChannel } from "#src/server/conversations/general-channel.server";
import { RedisClient } from "bun";
import { RedisMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import { PrismaWorkspaceCatalogStore } from "#src/server/workspaces/catalog.server";
import { PrismaWorkspaceEnrollmentStore } from "#src/server/workspaces/enrollment.server";
import { readAuthorizedAttachment } from "#src/server/attachments/attachment.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { DirectConversations } from "#src/server/conversations/direct-conversations.server";
import { decodeAgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import {
  executeAgentSendMessageWithPolicy,
  muteAgentChannel,
  readAgentMessages,
  unfollowAgentThread,
} from "#src/server/agents/agent-messages.server";
import { SendDirectMessage } from "#src/server/conversations/direct-message.server";
import { CentrifugoConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { PrismaAgentRepository } from "#src/server/db/repositories/agent.repositories.server";
import { PrismaWebPushSubscriptionStore } from "#src/server/notifications/prisma-web-push-subscriptions.server";
import type { MessageWebPushNotification } from "#src/server/notifications/web-push-notifications.server";
import { ConversationHistory } from "#src/server/conversations/conversation-history.server";
import { AgentChannelManagement } from "#src/server/conversations/agent-channel-management.server";
import { arrangeConversationPins } from "#src/server/conversations/conversation-pins.server";
import { isAppError } from "#src/lib/app-error";
import {
  MAX_THREAD_REFERENCES,
  storeMessageBody,
} from "#src/server/conversations/message-references.server";
import {
  notifyAgentMentionTargets,
  refuseAgentMentionAdds,
  pendingMentionActionsForAgent,
} from "#src/server/conversations/pending-mention-actions.server";
import { quietCentrifugo, recordingDeliveries, withPublishBatch } from "./helpers/fake-centrifugo";

const CHANNEL_MEMBER_CONTEXT = "[CoForge current channel role: member; coordinator=none]";

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
        muted: false,
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
    expect(subscriptionsOf(mentionNotification)).toEqual([
      expect.objectContaining({
        endpoint: `https://fcm.googleapis.com/wp/bob-${suffix}`,
      }),
    ]);
    // The target names the Chat tab: a member's own tab order can put another tab first.
    expect(mentionNotification?.url).toBe(
      `/notifications/open?workspace=${workspace.slug}&target=${encodeURIComponent(`/w/${workspace.slug}/channel/${engineering.id}?view=chat#message-${mutedMention.id}`)}`,
    );
    // An explicit @mention pierces the mute for notificationForRecipient too, with the same
    // title/body/url/tag/conversationPath the push payload carries.
    expect(await pushSubscriptions.notificationForRecipient(mutedMention.id, bob.id)).toEqual({
      title: mentionNotification!.title,
      body: mentionNotification!.body,
      url: mentionNotification!.url,
      tag: `message:${mutedMention.id}`,
      conversationPath: `/w/${workspace.slug}/channel/${engineering.id}`,
    });
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

test("Agent channel mute suppresses ordinary notices, preserves mentions and read access, and never backfills", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const user = await db.user.create({
    data: {
      displayName: `u${crypto.randomUUID().slice(0, 8)}`,
      username: `u${crypto.randomUUID().slice(0, 8)}`,
    },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: crypto.randomUUID(),
      name: "Agent channels",
      members: { create: { userId: user.id } },
    },
  });
  try {
    const computer = await db.computer.create({
      data: { ownerId: user.id, machineId: crypto.randomUUID() },
    });
    const agent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: user.id,
        computerId: computer.id,
        name: "helper",
        displayName: "Helper",
        runtimeConfig: {},
      },
    });
    await enrollGeneral(db, workspace.id);
    const published: ReturnType<typeof decodeAgentMessageDelivery>[] = [];
    let rejectNextPublish = false;
    const channels = new PublicChannels(
      db,
      new RedisMessageRequestIdempotency(redis),
      withPublishBatch({
        publish: async (_channel, payload) => {
          if (rejectNextPublish) {
            rejectNextPublish = false;
            throw new Error("controlled publish outage");
          }
          published.push(decodeAgentMessageDelivery(payload));
        },
        publishJson: async () => {},
        broadcast: async () => {},
      }),
    );
    const general = (await channels.list(workspace.id, user.id))[0]!;
    await db.userPreference.create({
      data: { userId: user.id, browserNotificationsEnabled: true },
    });
    await db.webPushSubscription.create({
      data: {
        userId: user.id,
        endpoint: `https://fcm.googleapis.com/wp/agent-mention-${workspace.id}`,
        p256dh: "p256dh",
        auth: "auth",
      },
    });
    expect(await channels.setAgentMuted(workspace.id, agent.id, "#general", true)).toEqual({
      muted: true,
    });
    await channels.send({
      workspaceId: workspace.id,
      userId: user.id,
      channelId: general.id,
      idempotencyKey: crypto.randomUUID(),
      body: "Ordinary conversation, no Agent requested.",
    });
    const repo = new PrismaDirectConversationRepository(db);
    expect(published).toEqual([]);
    expect(await repo.readPendingAgentDeliveries(workspace.id, agent.id)).toEqual([]);
    expect(await repo.readAgentRecoveryContext(workspace.id, agent.id)).toEqual({
      resumeMessages: [],
      unreadSummary: {},
    });
    expect(
      (await repo.readMessages(workspace.id, agent.id, "#general")).map((m) => [
        m.senderHandle,
        m.channelCoordination,
        m.body,
        m.target,
      ]),
    ).toEqual([
      [
        user.username,
        CHANNEL_MEMBER_CONTEXT,
        "Ordinary conversation, no Agent requested.",
        "#general",
      ],
    ]);
    const mentioned = await channels.send({
      workspaceId: workspace.id,
      userId: user.id,
      channelId: general.id,
      idempotencyKey: crypto.randomUUID(),
      body: "@helper please review this. @helper",
    });
    await channels.send({
      workspaceId: workspace.id,
      userId: user.id,
      channelId: general.id,
      idempotencyKey: crypto.randomUUID(),
      body: "Email x@helper.test and @helper-other are not a mention.",
    });
    const pending = await repo.readPendingAgentDeliveries(workspace.id, agent.id);
    expect(pending.map((m) => [m.messageId, m.target, m.latestSenderHandle])).toEqual([
      [mentioned.id, "#general", user.username],
    ]);
    const recovery = await repo.readAgentRecoveryContext(workspace.id, agent.id);
    expect(recovery.resumeMessages.map((m) => m.messageId)).toEqual([mentioned.id]);
    expect(recovery.unreadSummary).toEqual({ "#general": 1 });
    expect(
      (
        await repo.readMessagesPage(workspace.id, agent.id, "#general", {
          fromSequence: 1,
          throughSequence: mentioned.sequence + 1,
        })
      ).messages.map((m) => m.id),
    ).toEqual([mentioned.id]);
    expect(published.map((m) => [m.agentId, m.target, m.messageId])).toEqual([
      [agent.id, "#general", mentioned.id],
    ]);
    await channels.setAgentMuted(workspace.id, agent.id, "#general", false);
    expect(published.length).toBe(1);
    const ordinary = await channels.send({
      workspaceId: workspace.id,
      userId: user.id,
      channelId: general.id,
      idempotencyKey: crypto.randomUUID(),
      body: "New ordinary conversation after unmute.",
    });
    expect(published.map((m) => m.messageId)).toEqual([mentioned.id, ordinary.id]);
    expect(
      (await repo.searchMessages(workspace.id, agent.id, { query: "ordinary unmute" })).messages,
    ).toEqual([
      expect.objectContaining({
        id: ordinary.id,
        target: "#general",
        body: "New ordinary conversation after unmute.",
      }),
    ]);
    expect(
      (await repo.readAgentRecoveryContext(workspace.id, agent.id)).resumeMessages.map(
        (m) => m.messageId,
      ),
    ).toEqual([mentioned.id, ordinary.id]);
    const scope = { workspaceId: workspace.id, agentId: agent.id };
    const failingCentrifugo: CentrifugoServerApi = withPublishBatch({
      publish: async () => {
        throw new Error("Agent reply must not publish");
      },
      publishJson: async () => {
        throw new Error("Agent reply must not publish");
      },
      broadcast: async () => {
        throw new Error("Agent reply must not publish");
      },
    });
    const agentSender = new SendDirectMessage(
      repo,
      new RedisMessageRequestIdempotency(redis),
      failingCentrifugo,
      new CentrifugoConversationRealtime(failingCentrifugo),
    );
    await muteAgentChannel(repo, scope, "#general", true);
    expect(
      (await readAgentMessages(repo, scope, "#general", {})).messages.map((m) => m.body),
    ).toContain("New ordinary conversation after unmute.");
    const beforeReply = published.length;
    await channels.setUserMuted(workspace.id, user.id, general.id, true);
    const reply = await executeAgentSendMessageWithPolicy(
      { repository: repo, sender: agentSender },
      {
        idempotencyKey: crypto.randomUUID(),
        workspaceId: workspace.id,
        agentId: agent.id,
        target: "#general",
        content: `@${user.username} this Agent reply should notify the mentioned human`,
        seenUpToSeq: ordinary.sequence,
      },
    );
    expect(reply.state).toBe("sent");
    expect(published.length).toBe(beforeReply);
    if (!reply.messageId) throw new Error("Agent reply did not return its message identity");
    expect(
      subscriptionsOf(
        await new PrismaWebPushSubscriptionStore(db).notificationForMessage(reply.messageId),
      ),
    ).toEqual([
      expect.objectContaining({
        endpoint: `https://fcm.googleapis.com/wp/agent-mention-${workspace.id}`,
      }),
    ]);
    const opened = await channels.open(workspace.id, user.id, general.id);
    expect(opened.messages.at(-1)).toMatchObject({
      senderKind: "agent",
      senderName: "Helper",
      senderHandle: "helper",
      id: reply.messageId,
    });
    expect(
      (await repo.readPendingAgentDeliveries(workspace.id, agent.id)).some(
        (m) => m.messageId === reply.messageId,
      ),
    ).toBe(false);
    const second = await new PrismaAgentRepository(db).create({
      workspaceId: workspace.id,
      ownerId: user.id,
      computerId: computer.id,
      name: "scout",
      displayName: "Scout",
      runtimeConfig: {
        runtime: "codex",
        provider: { kind: "default" },
        model: "default",
        modelProvider: "openai",
        reasoning: "",
      },
    });
    // Creating a public Agent puts it in #general. Joining late opens the history to it, while
    // delivery (below) covers only what is sent afterwards.
    expect(await repo.readPendingAgentDeliveries(workspace.id, second.id)).toEqual([]);
    expect(
      (await repo.readMessages(workspace.id, second.id, "#general")).some(
        (m) => m.id === reply.messageId,
      ),
    ).toBe(true);
    const start = published.length;
    await channels.send({
      workspaceId: workspace.id,
      userId: user.id,
      channelId: general.id,
      idempotencyKey: crypto.randomUUID(),
      body: "An Agent joins #general muted, so ordinary chatter there does not reach it",
    });
    expect(published.slice(start).map((m) => m.agentId)).toEqual([]);
    await channels.setAgentMuted(workspace.id, second.id, "#general", false);
    const unmutedStart = published.length;
    await channels.send({
      workspaceId: workspace.id,
      userId: user.id,
      channelId: general.id,
      idempotencyKey: crypto.randomUUID(),
      body: "An unmuted channel update",
    });
    expect(published.slice(unmutedStart).map((m) => m.agentId)).toEqual([second.id]);

    const other = await channels.create(workspace.id, user.id, "not-joined");
    await expect(repo.readMessages(workspace.id, agent.id, "#not-joined")).rejects.toThrow(
      "ACCESS_DENIED",
    );
    await expect(
      channels.setAgentMuted(workspace.id, agent.id, "#not-joined", true),
    ).rejects.toThrow("ACCESS_DENIED");
    await expect(channels.setAgentMuted(workspace.id, agent.id, "@helper", true)).rejects.toThrow(
      "INVALID_INPUT",
    );
    await expect(repo.sendAgentMessage(other.id, agent.id, "not allowed")).rejects.toThrow(
      "agent is not a conversation member",
    );
    await expect(repo.readMessages(crypto.randomUUID(), agent.id, "#general")).rejects.toThrow(
      "ACCESS_DENIED",
    );
    await channels.setAgentMuted(workspace.id, agent.id, "#general", false);
    const retryInput = {
      workspaceId: workspace.id,
      userId: user.id,
      channelId: general.id,
      idempotencyKey: crypto.randomUUID(),
      body: "Both Agents were eligible before this publish outage.",
    };
    rejectNextPublish = true;
    await expect(channels.send(retryInput)).rejects.toThrow("controlled publish outage");
    const eligibleBeforeMute = await repo.readPendingAgentDeliveries(workspace.id, agent.id);
    const recoveredId = eligibleBeforeMute.at(-1)!.messageId;
    await channels.setAgentMuted(workspace.id, agent.id, "#general", true);
    await channels.setAgentMuted(workspace.id, second.id, "#general", true);
    const retryStart = published.length;
    expect((await channels.send(retryInput)).id).toBe(recoveredId);
    expect(
      published
        .slice(retryStart)
        .map((m) => m.agentId)
        .sort(),
    ).toEqual([agent.id, second.id].sort());
    expect(new Set(published.slice(retryStart).map((m) => m.messageId))).toEqual(
      new Set([recoveredId]),
    );
    expect(
      (await channels.open(workspace.id, user.id, general.id)).messages.filter(
        (m) => m.body === retryInput.body,
      ),
    ).toHaveLength(1);
    expect(
      (await repo.readAgentRecoveryContext(workspace.id, agent.id)).resumeMessages.some(
        (m) => m.messageId === recoveredId,
      ),
    ).toBe(true);
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.computer.deleteMany({ where: { ownerId: user.id } });
    await db.user.delete({ where: { id: user.id } });
    await db.$disconnect();
    redis.close();
  }
});

test("a channel @mention persists as a token and wakes only the mentioned Agent, including Agent-to-Agent", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const user = await db.user.create({
    data: {
      displayName: `u${crypto.randomUUID().slice(0, 8)}`,
      username: `u${crypto.randomUUID().slice(0, 8)}`,
    },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: crypto.randomUUID(),
      name: "Mention delivery",
      members: { create: { userId: user.id } },
    },
  });
  try {
    const computer = await db.computer.create({
      data: { ownerId: user.id, machineId: crypto.randomUUID() },
    });
    const helper = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: user.id,
        computerId: computer.id,
        name: "helper",
        displayName: "Helper",
        runtimeConfig: {},
      },
    });
    const scout = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: user.id,
        computerId: computer.id,
        name: "scout",
        displayName: "Scout",
        runtimeConfig: {},
      },
    });
    await enrollGeneral(db, workspace.id);
    const channels = new PublicChannels(
      db,
      new RedisMessageRequestIdempotency(redis),
      quietCentrifugo(),
    );
    const general = (await channels.list(workspace.id, user.id))[0]!;
    const repo = new PrismaDirectConversationRepository(db);
    const agentSender = new SendDirectMessage(
      repo,
      new RedisMessageRequestIdempotency(redis),
      quietCentrifugo(),
    );

    const humanMention = await channels.send({
      workspaceId: workspace.id,
      userId: user.id,
      channelId: general.id,
      idempotencyKey: crypto.randomUUID(),
      body: "@helper please triage this.",
    });
    expect(humanMention.body).toBe(`<@agent:${helper.id}> please triage this.`);
    expect(
      (await db.messageMention.findMany({ where: { messageId: humanMention.id } })).map((row) => [
        row.kind,
        row.handle,
        row.actorId,
        row.conversationId,
      ]),
    ).toEqual([["agent", "helper", helper.id, general.id]]);
    expect(
      (await db.agentMessageDelivery.findMany({ where: { messageId: humanMention.id } })).map(
        (row) => row.agentId,
      ),
    ).toEqual([helper.id]);
    expect<string | undefined>(
      (await repo.readMessages(workspace.id, helper.id, "#general")).find(
        (message) => message.id === humanMention.id,
      )?.body,
    ).toBe("@helper please triage this.");

    const handoff = await agentSender.executeFromAgent({
      idempotencyKey: crypto.randomUUID(),
      workspaceId: workspace.id,
      agentId: helper.id,
      target: "#general",
      body: "@scout please take the follow-up.",
    });
    expect(handoff.body).toBe(`<@agent:${scout.id}> please take the follow-up.`);
    expect(
      (await db.agentMessageDelivery.findMany({ where: { messageId: handoff.id } })).map(
        (row) => row.agentId,
      ),
    ).toEqual([scout.id]);
    // Eligibility for Agent attention rests on the delivery row, not on the sender's kind, so an
    // Agent-authored handoff is admitted here and every Agent-facing projection names its author.
    expect(
      (await repo.readPendingAgentDeliveries(workspace.id, scout.id)).find(
        (message) => message.messageId === handoff.id,
      ),
    ).toMatchObject({
      latestSenderKind: "agent",
      latestSenderHandle: "helper",
      target: "#general",
    });
    expect(
      (await repo.readAgentRecoveryContext(workspace.id, scout.id)).resumeMessages.find(
        (message) => message.messageId === handoff.id,
      ),
    ).toMatchObject({
      latestSenderKind: "agent",
      latestSenderHandle: "helper",
      target: "#general",
    });
    expect(
      (
        await (await repo.agentTargetFreshness(workspace.id, scout.id, "#general")).readPending(0)
      ).find((message) => message.id === handoff.id),
    ).toMatchObject({ senderKind: "agent", senderHandle: "helper", target: "#general" });
    expect<string | undefined>(
      (await repo.readMessages(workspace.id, scout.id, "#general")).find(
        (message) => message.id === handoff.id,
      )?.body,
    ).toBe("@scout please take the follow-up.");
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.computer.deleteMany({ where: { ownerId: user.id } });
    await db.user.delete({ where: { id: user.id } });
    await db.$disconnect();
    redis.close();
  }
});

test("an Agent's channel message reaches other Agents without an @mention: unmuted members at the top level, followers in a thread, never the sender", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const user = await db.user.create({
    data: {
      displayName: `u${crypto.randomUUID().slice(0, 8)}`,
      username: `u${crypto.randomUUID().slice(0, 8)}`,
    },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: crypto.randomUUID(),
      name: "Agent chatter",
      members: { create: { userId: user.id } },
    },
  });
  try {
    const computer = await db.computer.create({
      data: { ownerId: user.id, machineId: crypto.randomUUID() },
    });
    const agent = (name: string) =>
      db.agent.create({
        data: {
          workspaceId: workspace.id,
          ownerId: user.id,
          computerId: computer.id,
          name,
          displayName: name,
          runtimeConfig: {},
        },
      });
    const helper = await agent("helper");
    const scout = await agent("scout");
    // Muted in #general like every Agent joining it, so it never hears the unaddressed chatter.
    await agent("quiet");
    await enrollGeneral(db, workspace.id);
    const channels = new PublicChannels(
      db,
      new RedisMessageRequestIdempotency(redis),
      quietCentrifugo(),
    );
    const general = (await channels.list(workspace.id, user.id))[0]!;
    await channels.setAgentMuted(workspace.id, helper.id, "#general", false);
    await channels.setAgentMuted(workspace.id, scout.id, "#general", false);
    const repo = new PrismaDirectConversationRepository(db);
    const recipients = (message: { deliveries: { agentId: string }[] }) =>
      message.deliveries.map((delivery) => delivery.agentId).sort();

    // A top-level post belongs to the channel: every unmuted Agent member but the sender.
    const status = await repo.sendAgentMessage(general.id, helper.id, "Build is green.");
    expect(recipients(status)).toEqual([scout.id]);
    expect(
      (await repo.readPendingAgentDeliveries(workspace.id, scout.id)).map((row) => [
        row.messageId,
        row.latestSenderKind,
      ]),
    ).toEqual([[status.id, "agent"]]);

    // A thread reply belongs to its thread: only the followers, never the sender.
    const root = await channels.send({
      workspaceId: workspace.id,
      userId: user.id,
      channelId: general.id,
      idempotencyKey: crypto.randomUUID(),
      body: "Who takes the release notes?",
    });
    const thread = root.id;
    const first = await repo.sendAgentMessage(general.id, helper.id, "I can.", [], thread);
    expect(recipients(first)).toEqual([]);
    const second = await repo.sendAgentMessage(general.id, scout.id, "Me too.", [], thread);
    expect(recipients(second)).toEqual([helper.id]);
    const third = await repo.sendAgentMessage(general.id, helper.id, "Split it then.", [], thread);
    expect(recipients(third)).toEqual([scout.id]);
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.computer.deleteMany({ where: { ownerId: user.id } });
    await db.user.delete({ where: { id: user.id } });
    await db.$disconnect();
    redis.close();
  }
});

test("a channel send reports the @handles that name nobody the sender can see, and a replay reports the same", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const suffix = crypto.randomUUID().slice(0, 8);
  const alice = await db.user.create({
    data: { displayName: `ua${suffix}`, username: `ua${suffix}` },
  });
  const bob = await db.user.create({
    data: { displayName: `ub${suffix}`, username: `ub${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: crypto.randomUUID(),
      name: "Unresolved mentions",
      members: { create: [{ userId: alice.id }, { userId: bob.id }] },
    },
  });
  try {
    const computer = await db.computer.create({
      data: { ownerId: bob.id, machineId: crypto.randomUUID() },
    });
    // A public Agent outside the channel is someone the sender can see; a private Agent of
    // another owner is not.
    await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: bob.id,
        computerId: computer.id,
        name: "helper",
        displayName: "Helper",
        runtimeConfig: {},
      },
    });
    await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: bob.id,
        computerId: computer.id,
        name: "secret",
        displayName: "Secret",
        visibility: "private",
        runtimeConfig: {},
      },
    });
    const channels = new PublicChannels(
      db,
      new RedisMessageRequestIdempotency(redis),
      quietCentrifugo(),
    );
    const triage = await channels.create(workspace.id, alice.id, `triage-${suffix}`);
    const send = {
      workspaceId: workspace.id,
      userId: alice.id,
      channelId: triage.id,
      idempotencyKey: crypto.randomUUID(),
      body: `@ua${suffix} @helper @ub${suffix} @ghost @secret \`@quoted\` @ghost in #triage-${suffix} <@human:00000000-0000-4000-8000-000000000000>`,
    };

    const sent = await channels.send(send);
    // The sender resolves as a member; helper and bob are Workspace members outside the channel;
    // ghost names nobody and secret is invisible to the sender; code is never a mention, and a
    // stored token (the channel reference, a typed mention token) is never read as a handle.
    expect(sent.unresolvedMentionHandles).toEqual(["ghost", "secret"]);
    expect((await channels.send(send)).unresolvedMentionHandles).toEqual(["ghost", "secret"]);
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.computer.deleteMany({ where: { ownerId: bob.id } });
    await db.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
    await db.$disconnect();
    redis.close();
  }
});

test("a channel send names a member by id beside the @handles in its body, and a binding that names no member of the channel names no one", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const suffix = crypto.randomUUID().slice(0, 8);
  const alice = await db.user.create({
    data: { displayName: `ua${suffix}`, username: `ua${suffix}` },
  });
  const bob = await db.user.create({
    data: { displayName: `ub${suffix}`, username: `ub${suffix}` },
  });
  const carol = await db.user.create({
    data: { displayName: `uc${suffix}`, username: `uc${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: crypto.randomUUID(),
      name: "Mention bindings",
      members: { create: [{ userId: alice.id }, { userId: bob.id }, { userId: carol.id }] },
    },
  });
  try {
    const computer = await db.computer.create({
      data: { ownerId: alice.id, machineId: crypto.randomUUID() },
    });
    // An Agent that holds the handle of a person: the text alone can only name the Agent. Created
    // straight in the database, since Agent creation now refuses the name; this is about how a send
    // resolves such a pair, which older Agents and members who joined later can still make.
    const namesake = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: alice.id,
        computerId: computer.id,
        name: bob.username,
        displayName: "Namesake",
        runtimeConfig: {},
      },
    });
    await enrollGeneral(db, workspace.id);
    const channels = new PublicChannels(
      db,
      new RedisMessageRequestIdempotency(redis),
      quietCentrifugo(),
    );
    const general = (await channels.list(workspace.id, alice.id))[0]!;
    const send = (
      channelId: string,
      body: string,
      mentions?: { type: "user" | "agent"; id: string; name: string }[],
    ) =>
      channels.send({
        workspaceId: workspace.id,
        userId: alice.id,
        channelId,
        idempotencyKey: crypto.randomUUID(),
        body,
        mentions,
      });
    const mentioned = async (messageId: string) =>
      (await db.messageMention.findMany({ where: { messageId } }))
        .map((row) => `${row.kind}:${row.actorId}`)
        .sort();

    // The handle in the text is the Agent's; the person the sender picked is mentioned as well.
    expect(await mentioned((await send(general.id, `@${bob.username} look`)).id)).toEqual([
      `agent:${namesake.id}`,
    ]);
    const bound = await send(general.id, `@${bob.username} look`, [
      { type: "user", id: bob.id, name: bob.username },
    ]);
    expect(await mentioned(bound.id)).toEqual([`agent:${namesake.id}`, `user:${bob.id}`].sort());

    // A binding is a claim: bob's id under carol's handle, or a person who is no member of this
    // channel, names no one.
    const forged = await send(general.id, "hello", [
      { type: "user", id: bob.id, name: carol.username },
    ]);
    expect(await mentioned(forged.id)).toEqual([]);
    const solo = await channels.create(workspace.id, alice.id, `solo-${suffix}`);
    const outside = await send(solo.id, "hello", [
      { type: "user", id: bob.id, name: bob.username },
    ]);
    expect(await mentioned(outside.id)).toEqual([]);
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.computer.deleteMany({ where: { ownerId: alice.id } });
    await db.user.deleteMany({ where: { id: { in: [alice.id, bob.id, carol.id] } } });
    await db.$disconnect();
    redis.close();
  }
});

test("a channel @mention of someone outside the channel becomes the sender's pending mention action for 7 days, and a replay returns the same one", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const suffix = crypto.randomUUID().slice(0, 8);
  const alice = await db.user.create({
    data: { displayName: `pa${suffix}`, username: `pa${suffix}` },
  });
  const bob = await db.user.create({
    data: { displayName: `pb${suffix}`, username: `pb${suffix}` },
  });
  const carol = await db.user.create({
    data: { displayName: `pc${suffix}`, username: `pc${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: crypto.randomUUID(),
      name: "Pending mentions",
      members: { create: [{ userId: alice.id }, { userId: bob.id }, { userId: carol.id }] },
    },
  });
  try {
    const computer = await db.computer.create({
      data: { ownerId: bob.id, machineId: crypto.randomUUID() },
    });
    const helper = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: bob.id,
        computerId: computer.id,
        name: "helper",
        displayName: "Helper",
        runtimeConfig: {},
      },
    });
    // A private Agent the sender can see (its owner) still cannot join a channel.
    await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: alice.id,
        computerId: computer.id,
        name: "mine",
        displayName: "Mine",
        visibility: "private",
        runtimeConfig: {},
      },
    });
    const channels = new PublicChannels(
      db,
      new RedisMessageRequestIdempotency(redis),
      quietCentrifugo(),
    );
    const triage = await channels.create(workspace.id, alice.id, `pending-${suffix}`);
    await channels.addMembers(workspace.id, { userId: alice.id }, triage.id, {
      userIds: [carol.id],
      agentIds: [],
    });
    const send = {
      workspaceId: workspace.id,
      userId: alice.id,
      channelId: triage.id,
      idempotencyKey: crypto.randomUUID(),
      body: `@pc${suffix} @pb${suffix} @helper @mine \`@pb${suffix}\` @ghost @pb${suffix}`,
    };

    const sent = await channels.send(send);
    // Carol is a member and was mentioned; bob and helper are outside the channel; a private
    // Agent is never offered; ghost is unresolved; code is never a mention.
    expect(
      sent.pendingMentionActions.map((action) => [
        action.targetType,
        action.targetId,
        action.targetHandle,
        action.availableActions,
      ]),
    ).toEqual([
      ["user", bob.id, `pb${suffix}`, ["notify", "add"]],
      ["agent", helper.id, "helper", ["notify", "add"]],
    ]);
    expect(sent.unresolvedMentionHandles).toEqual(["ghost"]);
    for (const action of sent.pendingMentionActions) {
      expect(action.messageId).toBe(sent.id);
      expect(new Date(action.expiresAt).getTime() - sent.createdAt.getTime()).toBe(
        7 * 24 * 60 * 60 * 1000,
      );
    }
    const replay = await channels.send(send);
    expect(replay.pendingMentionActions.map((action) => action.resolutionId)).toEqual(
      sent.pendingMentionActions.map((action) => action.resolutionId),
    );
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.computer.deleteMany({ where: { ownerId: bob.id } });
    await db.user.deleteMany({ where: { id: { in: [alice.id, bob.id, carol.id] } } });
    await db.$disconnect();
    redis.close();
  }
});

test("an Agent's channel @mention of someone outside the channel becomes that Agent's pending mention action; a DM @handle never does", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const suffix = crypto.randomUUID().slice(0, 8);
  const alice = await db.user.create({
    data: { displayName: `ga${suffix}`, username: `ga${suffix}` },
  });
  const bob = await db.user.create({
    data: { displayName: `gb${suffix}`, username: `gb${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: crypto.randomUUID(),
      name: "Agent pending mentions",
      members: { create: [{ userId: alice.id }, { userId: bob.id }] },
    },
  });
  try {
    const computer = await db.computer.create({
      data: { ownerId: alice.id, machineId: crypto.randomUUID() },
    });
    const agent = (name: string) =>
      db.agent.create({
        data: {
          workspaceId: workspace.id,
          ownerId: alice.id,
          computerId: computer.id,
          name,
          displayName: name,
          runtimeConfig: {},
        },
      });
    const scout = await agent("scout");
    const helper = await agent("helper");
    const channels = new PublicChannels(
      db,
      new RedisMessageRequestIdempotency(redis),
      quietCentrifugo(),
    );
    const triage = await channels.create(workspace.id, alice.id, `agentsend-${suffix}`);
    await channels.addMembers(workspace.id, { userId: alice.id }, triage.id, {
      userIds: [],
      agentIds: [scout.id],
    });
    const repo = new PrismaDirectConversationRepository(db);
    const sender = new SendDirectMessage(
      repo,
      new RedisMessageRequestIdempotency(redis),
      quietCentrifugo(),
    );
    const send = {
      idempotencyKey: crypto.randomUUID(),
      workspaceId: workspace.id,
      agentId: scout.id,
      target: `#agentsend-${suffix}`,
      body: `@ga${suffix} @gb${suffix} @helper @ghost please look`,
    };

    const sent = await sender.executeFromAgent(send);
    // alice is a member; bob and helper are outside the channel; ghost names nobody.
    expect(
      sent.pendingMentionActions.map((action) => [
        action.targetType,
        action.targetId,
        action.targetHandle,
      ]),
    ).toEqual([
      ["user", bob.id, `gb${suffix}`],
      ["agent", helper.id, "helper"],
    ]);
    expect(sent.unresolvedMentionHandles).toEqual(["ghost"]);
    // Every row offers Notify and Add; whether the sender may add is decided when it tries.
    expect(sent.pendingMentionActions.map((action) => action.availableActions)).toEqual([
      ["notify", "add"],
      ["notify", "add"],
    ]);
    const replay = await sender.executeFromAgent(send);
    expect(replay.pendingMentionActions.map((action) => action.resolutionId)).toEqual(
      sent.pendingMentionActions.map((action) => action.resolutionId),
    );

    // The Agent lists what it may still act on, across its channels; adding is a human's call,
    // notifying is not.
    const pending = await pendingMentionActionsForAgent(db, workspace.id, scout.id);
    expect(
      pending.map((action) => [action.targetHandle, action.channelName, action.availableActions]),
    ).toEqual([
      [`gb${suffix}`, `agentsend-${suffix}`, ["notify", "add"]],
      ["helper", `agentsend-${suffix}`, ["notify", "add"]],
    ]);
    const unknown = crypto.randomUUID();
    expect(
      (
        await refuseAgentMentionAdds(db, workspace.id, scout.id, [
          sent.pendingMentionActions[0]!.resolutionId,
          unknown,
        ])
      ).map((result) => [result.resolutionId, result.status, result.reason]),
    ).toEqual([
      [
        sent.pendingMentionActions[0]!.resolutionId,
        "no_permission",
        "add_requires_human_member_authority",
      ],
      [unknown, "not_found", undefined],
    ]);
    // Another Agent never sees or acts on these.
    expect(await pendingMentionActionsForAgent(db, workspace.id, helper.id)).toEqual([]);
    const notified = await notifyAgentMentionTargets(db, workspace.id, scout.id, [
      sent.pendingMentionActions[0]!.resolutionId,
    ]);
    expect(notified.map((result) => [result.status, result.reason])).toEqual([
      ["queued", undefined],
    ]);
    expect(
      (await pendingMentionActionsForAgent(db, workspace.id, scout.id)).map(
        (action) => action.availableActions,
      ),
    ).toEqual([["add"], ["notify", "add"]]);

    const direct = await sender.executeFromAgent({
      idempotencyKey: crypto.randomUUID(),
      workspaceId: workspace.id,
      agentId: scout.id,
      target: `@ga${suffix}`,
      body: `@gb${suffix} is not here`,
    });
    expect(direct.pendingMentionActions).toEqual([]);
    expect(await db.pendingMentionAction.count({ where: { messageId: direct.id } })).toBe(0);
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.computer.deleteMany({ where: { ownerId: alice.id } });
    await db.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
    await db.$disconnect();
    redis.close();
  }
});

test("the sender notifies a mentioned outsider once: an Agent gets the message as a non-member delivery, a person is marked notified, and the mention stays addable", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const suffix = crypto.randomUUID().slice(0, 8);
  const alice = await db.user.create({
    data: { displayName: `na${suffix}`, username: `na${suffix}` },
  });
  const bob = await db.user.create({
    data: { displayName: `nb${suffix}`, username: `nb${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: crypto.randomUUID(),
      name: "Mention notify",
      members: { create: [{ userId: alice.id }, { userId: bob.id }] },
    },
  });
  try {
    const computer = await db.computer.create({
      data: { ownerId: alice.id, machineId: crypto.randomUUID() },
    });
    const helper = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: alice.id,
        computerId: computer.id,
        name: "helper",
        displayName: "Helper",
        runtimeConfig: {},
      },
    });
    const published: { channel: string; data: unknown }[] = [];
    const channels = new PublicChannels(
      db,
      new RedisMessageRequestIdempotency(redis),
      withPublishBatch({
        ...quietCentrifugo(),
        publish: async (channel: string, data: Uint8Array) => {
          published.push({ channel, data });
        },
      }),
    );
    const triage = await channels.create(workspace.id, alice.id, `notify-${suffix}`);
    const send = {
      workspaceId: workspace.id,
      userId: alice.id,
      channelId: triage.id,
      idempotencyKey: crypto.randomUUID(),
      body: `@nb${suffix} and @helper, have a look`,
    };
    const sent = await channels.send(send);
    const [forBob, forHelper] = sent.pendingMentionActions.map((action) => action.resolutionId);

    const results = await channels.executeMentionActions(workspace.id, alice.id, "notify", [
      forBob!,
      forHelper!,
    ]);
    expect(results.map((result) => [result.targetType, result.status, result.reason])).toEqual([
      ["user", "queued", undefined],
      ["agent", "queued", undefined],
    ]);
    // The Agent gets this one message, marked as reaching it outside the channel.
    const delivery = decodeAgentMessageDelivery(published.at(-1)!.data as Uint8Array);
    expect([delivery.agentId, delivery.messageId, delivery.nonMemberMention]).toEqual([
      helper.id,
      sent.id,
      true,
    ]);
    const repo = new PrismaDirectConversationRepository(db);
    expect(
      (await repo.readPendingAgentDeliveries(workspace.id, helper.id)).map((pending) => [
        pending.messageId,
        pending.nonMemberMention,
      ]),
    ).toEqual([[sent.id, true]]);
    // A restart's recovery carries it with the same flag.
    expect(
      (await repo.readAgentRecoveryContext(workspace.id, helper.id)).resumeMessages.map(
        (message) => [message.messageId, message.nonMemberMention],
      ),
    ).toEqual([[sent.id, true]]);
    // Its `message check`, scoped to the channel as its inbox notice says, reads the message once,
    // marked as reaching it outside the channel; the channel's history stays closed to it.
    const drained = await repo.drainAgentEvents(workspace.id, helper.id, 20, `#notify-${suffix}`);
    expect(
      drained.messages.map((message) => [message.id, message.target, message.nonMemberMention]),
    ).toEqual([[sent.id, `#notify-${suffix}`, true]]);
    expect((await repo.drainAgentEvents(workspace.id, helper.id)).messages).toEqual([]);
    expect(
      await repo
        .readMessages(workspace.id, helper.id, `#notify-${suffix}`)
        .then(() => "read")
        .catch(() => "refused"),
    ).toBe("refused");
    // Notified once; still addable.
    expect(
      (
        await channels.executeMentionActions(workspace.id, alice.id, "notify", [
          forBob!,
          forHelper!,
        ])
      ).map((result) => [result.status, result.reason]),
    ).toEqual([
      ["queued", "already_queued"],
      ["queued", "already_queued"],
    ]);
    // One outsider delivery and one ordinary delivery to the channel's Memory Agent.
    expect(await db.agentMessageDelivery.count({ where: { messageId: sent.id } })).toBe(2);
    expect(
      (await channels.send(send)).pendingMentionActions.map((action) => action.availableActions),
    ).toEqual([["add"], ["add"]]);
    // Once added, the Agent reads the channel as a member: the message it already read as a
    // non-member is not read again, and nothing replays as reaching it from outside.
    expect(
      (await channels.executeMentionActions(workspace.id, alice.id, "add", [forHelper!])).map(
        (result) => result.status,
      ),
    ).toEqual(["delivered"]);
    expect((await repo.drainAgentEvents(workspace.id, helper.id)).messages).toEqual([]);
    expect(
      (await repo.readPendingAgentDeliveries(workspace.id, helper.id)).map((pending) => [
        pending.messageId,
        pending.nonMemberMention,
      ]),
    ).toEqual([[sent.id, undefined]]);
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.computer.deleteMany({ where: { ownerId: alice.id } });
    await db.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
    await db.$disconnect();
    redis.close();
  }
});

test("the sender adds a mentioned outsider to the channel once; another member's id, an expired one and a repeat are refused", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const suffix = crypto.randomUUID().slice(0, 8);
  const alice = await db.user.create({
    data: { displayName: `xa${suffix}`, username: `xa${suffix}` },
  });
  const bob = await db.user.create({
    data: { displayName: `xb${suffix}`, username: `xb${suffix}` },
  });
  const carol = await db.user.create({
    data: { displayName: `xc${suffix}`, username: `xc${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: crypto.randomUUID(),
      name: "Mention actions",
      members: { create: [{ userId: alice.id }, { userId: bob.id }, { userId: carol.id }] },
    },
  });
  try {
    const computer = await db.computer.create({
      data: { ownerId: bob.id, machineId: crypto.randomUUID() },
    });
    const helper = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: bob.id,
        computerId: computer.id,
        name: "helper",
        displayName: "Helper",
        runtimeConfig: {},
      },
    });
    const announced: string[][] = [];
    const channels = new PublicChannels(
      db,
      new RedisMessageRequestIdempotency(redis),
      quietCentrifugo(),
      undefined,
      {
        messageAvailable: async () => {},
        memberChanged: async (event: { conversationIds: string[] }) => {
          announced.push(event.conversationIds);
        },
      } as unknown as ConstructorParameters<typeof PublicChannels>[4],
    );
    const triage = await channels.create(workspace.id, alice.id, `actions-${suffix}`);
    await channels.addMembers(workspace.id, { userId: alice.id }, triage.id, {
      userIds: [carol.id],
      agentIds: [],
    });
    announced.length = 0;
    const sent = await channels.send({
      workspaceId: workspace.id,
      userId: alice.id,
      channelId: triage.id,
      idempotencyKey: crypto.randomUUID(),
      body: `@xb${suffix} and @helper, please look`,
    });
    const [forBob, forHelper] = sent.pendingMentionActions.map((action) => action.resolutionId);

    // Only the sender can act on their pending mentions.
    expect(
      (await channels.executeMentionActions(workspace.id, carol.id, "add", [forBob!])).map(
        (result) => [result.resolutionId, result.status],
      ),
    ).toEqual([[forBob, "not_found"]]);

    const added = await channels.executeMentionActions(workspace.id, alice.id, "add", [
      forBob!,
      forHelper!,
    ]);
    expect(added.map((result) => [result.targetType, result.targetId, result.status])).toEqual([
      ["user", bob.id, "delivered"],
      ["agent", helper.id, "delivered"],
    ]);
    expect(
      await db.conversationMember.count({
        where: {
          conversationId: triage.id,
          leftAt: null,
          OR: [{ userId: bob.id }, { agentId: helper.id }],
        },
      }),
    ).toBe(2);
    expect(announced).toEqual([[triage.id]]);
    // Someone who left the Workspace after the send cannot be added, and does not sink the others
    // added in the same request; nor can a target already in the channel, nor another Workspace.
    const dave = await db.user.create({
      data: { displayName: `xe${suffix}`, username: `xe${suffix}` },
    });
    const frank = await db.user.create({
      data: { displayName: `xf${suffix}`, username: `xf${suffix}` },
    });
    const elsewhere = await db.workspace.create({
      data: {
        slug: crypto.randomUUID(),
        name: "Elsewhere",
        members: { create: { userId: alice.id } },
      },
    });
    try {
      await db.workspaceMembership.createMany({
        data: [dave.id, frank.id].map((userId) => ({ workspaceId: workspace.id, userId })),
      });
      const mixed = await channels.send({
        workspaceId: workspace.id,
        userId: alice.id,
        channelId: triage.id,
        idempotencyKey: crypto.randomUUID(),
        body: `@xe${suffix} and @xf${suffix}`,
      });
      const [forDave, forFrank] = mixed.pendingMentionActions.map((action) => action.resolutionId);
      await db.workspaceMembership.deleteMany({
        where: { workspaceId: workspace.id, userId: dave.id },
      });
      expect(
        (
          await channels.send({
            workspaceId: workspace.id,
            userId: alice.id,
            channelId: triage.id,
            idempotencyKey: crypto.randomUUID(),
            body: `@xe${suffix} again`,
          })
        ).pendingMentionActions,
      ).toEqual([]);
      expect(
        (
          await channels.executeMentionActions(workspace.id, alice.id, "add", [forDave!, forFrank!])
        ).map((result) => [result.status, result.reason]),
      ).toEqual([
        ["stale", "target_unavailable"],
        ["delivered", undefined],
      ]);
      expect(
        (await channels.executeMentionActions(elsewhere.id, alice.id, "add", [forDave!])).map(
          (result) => result.status,
        ),
      ).toEqual(["not_found"]);
    } finally {
      await db.workspace.delete({ where: { id: elsewhere.id } });
      await db.workspaceMembership.deleteMany({ where: { userId: { in: [dave.id, frank.id] } } });
      await db.conversationMember.deleteMany({ where: { userId: { in: [dave.id, frank.id] } } });
      await db.user.deleteMany({ where: { id: { in: [dave.id, frank.id] } } });
    }
    // Acted on once; the send's own list no longer offers it.
    expect(
      (await channels.executeMentionActions(workspace.id, alice.id, "add", [forBob!])).map(
        (result) => [result.status, result.reason],
      ),
    ).toEqual([["stale", "no_longer_pending"]]);

    const later = await channels.send({
      workspaceId: workspace.id,
      userId: carol.id,
      channelId: triage.id,
      idempotencyKey: crypto.randomUUID(),
      body: `@xa${suffix} is here already; @helper too`,
    });
    expect(later.pendingMentionActions).toEqual([]);
    const outsider = await db.user.create({
      data: { displayName: `xd${suffix}`, username: `xd${suffix}` },
    });
    try {
      await db.workspaceMembership.create({
        data: { workspaceId: workspace.id, userId: outsider.id },
      });
      const old = await channels.send({
        workspaceId: workspace.id,
        userId: alice.id,
        channelId: triage.id,
        idempotencyKey: crypto.randomUUID(),
        body: `@xd${suffix} ping`,
      });
      const forOutsider = old.pendingMentionActions[0]!.resolutionId;
      // Someone who joined in the meantime needs nothing done.
      const joinedSince = await channels.send({
        workspaceId: workspace.id,
        userId: alice.id,
        channelId: triage.id,
        idempotencyKey: crypto.randomUUID(),
        body: `@xd${suffix} once more`,
      });
      await db.conversationMember.create({
        data: { workspaceId: workspace.id, conversationId: triage.id, userId: outsider.id },
      });
      expect(
        (
          await channels.executeMentionActions(workspace.id, alice.id, "add", [
            joinedSince.pendingMentionActions[0]!.resolutionId,
          ])
        ).map((result) => [result.status, result.reason]),
      ).toEqual([["stale", "target_already_member"]]);
      await db.conversationMember.deleteMany({
        where: { conversationId: triage.id, userId: outsider.id },
      });
      await db.pendingMentionAction.update({
        where: { id: forOutsider },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      expect(
        (await channels.executeMentionActions(workspace.id, alice.id, "add", [forOutsider])).map(
          (result) => result.status,
        ),
      ).toEqual(["expired"]);
      // Nobody joins an archived channel, including from a mention.
      const beforeArchive = await channels.send({
        workspaceId: workspace.id,
        userId: alice.id,
        channelId: triage.id,
        idempotencyKey: crypto.randomUUID(),
        body: `@xd${suffix} last call`,
      });
      await db.conversation.update({ where: { id: triage.id }, data: { archivedAt: new Date() } });
      expect(
        (
          await channels.executeMentionActions(workspace.id, alice.id, "add", [
            beforeArchive.pendingMentionActions[0]!.resolutionId,
          ])
        ).map((result) => [result.status, result.reason]),
      ).toEqual([["no_permission", "channel_archived"]]);
    } finally {
      await db.workspaceMembership.deleteMany({ where: { userId: outsider.id } });
      await db.user.delete({ where: { id: outsider.id } }).catch(() => {});
    }
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.computer.deleteMany({ where: { ownerId: bob.id } });
    await db.user.deleteMany({ where: { id: { in: [alice.id, bob.id, carol.id] } } });
    await db.$disconnect();
    redis.close();
  }
});

test("a body's thread references are read in one query per channel, and only the first MAX_THREAD_REFERENCES of them", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const user = await db.user.create({
    data: {
      displayName: `u${crypto.randomUUID().slice(0, 8)}`,
      username: `u${crypto.randomUUID().slice(0, 8)}`,
    },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: crypto.randomUUID(),
      name: "Thread reference reads",
      members: { create: { userId: user.id } },
    },
  });
  try {
    await enrollGeneral(db, workspace.id);
    const channels = new PublicChannels(
      db,
      new RedisMessageRequestIdempotency(redis),
      quietCentrifugo(),
    );
    const general = (await channels.list(workspace.id, user.id))[0]!;
    const product = await channels.create(workspace.id, user.id, "product");
    const random = await channels.create(workspace.id, user.id, "random");
    let sequence = 1_000_000;
    const createRoot = async (conversationId: string, id = crypto.randomUUID()) =>
      (
        await db.message.create({
          data: {
            id,
            conversationId,
            workspaceId: workspace.id,
            body: "root",
            sequence: sequence++,
          },
        })
      ).id;
    // Six roots in #product, two more sharing a six-hex prefix, one root in #random.
    const productRoots = await Promise.all(Array.from({ length: 6 }, () => createRoot(product.id)));
    const prefix = crypto.randomUUID().slice(0, 6);
    await createRoot(product.id, `${prefix}00-0000-4000-8000-000000000000`);
    await createRoot(product.id, `${prefix}ff-0000-4000-8000-000000000001`);
    const randomRoot = await createRoot(random.id);
    const token = (channel: { id: string }, name: string, root: string) =>
      `<@thread:${channel.id}:${root}:${name}>`;

    /** `storeMessageBody` in a transaction whose message reads are counted. */
    const store = (body: string) =>
      db.$transaction(async (tx) => {
        const reads: unknown[] = [];
        const counted = {
          task: tx.task,
          conversation: tx.conversation,
          message: {
            findMany: (args: Parameters<typeof tx.message.findMany>[0]) => {
              reads.push(args);
              return tx.message.findMany(args);
            },
          },
        } as unknown as Parameters<typeof storeMessageBody>[0];
        const stored = await storeMessageBody(
          counted,
          { workspaceId: workspace.id, conversationId: general.id },
          body,
          { targets: [] },
        );
        return { body: stored.body, reads: reads.length };
      });

    // References into two channels take one read each, however many there are; a prefix two
    // messages share, read in the same batch, still names nothing.
    const [first] = productRoots;
    const mixed = await store(
      [
        `#product:${first!.slice(0, 8)}`,
        `#product:${prefix}`,
        `#product:${first!.slice(0, 6)}`,
        `#random:${randomRoot.slice(0, 7)}`,
        `#random:${randomRoot}`,
        "#nope:abcdef12",
      ].join(" "),
    );
    expect(mixed.body).toBe(
      [
        token(product, "product", first!),
        `#product:${prefix}`,
        token(product, "product", first!),
        token(random, "random", randomRoot),
        token(random, "random", randomRoot),
        "#nope:abcdef12",
      ].join(" "),
    );
    expect(mixed.reads).toBe(2);

    // Twenty-four distinct references: the first MAX_THREAD_REFERENCES resolve, the rest stay text.
    const spellings = productRoots.flatMap((root) => [
      `#product:${root.slice(0, 6)}`,
      `#product:${root.slice(0, 7)}`,
      `#product:${root.slice(0, 8)}`,
      `#product:${root}`,
    ]);
    expect(spellings.length).toBeGreaterThan(MAX_THREAD_REFERENCES);
    const capped = await store(spellings.join(" "));
    expect(capped.body).toBe(
      spellings
        .map((written, index) =>
          index < MAX_THREAD_REFERENCES
            ? token(product, "product", productRoots[Math.floor(index / 4)]!)
            : written,
        )
        .join(" "),
    );
    expect(capped.reads).toBe(1);
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.delete({ where: { id: user.id } });
    await db.$disconnect();
    redis.close();
  }
});

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
    // The window holds the root and its thread's summary; the replies come with the thread read.
    expect(opened.messages.map((message) => message.id)).toEqual([root.id]);
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
    expect(
      subscriptionsOf(await pushSubscriptions.notificationForMessage(followerNotice.id)),
    ).toEqual([
      expect.objectContaining({
        endpoint: `https://fcm.googleapis.com/wp/channel-thread-${suffix}`,
      }),
    ]);
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

function enrollGeneral(db: PrismaClient, workspaceId: string) {
  return db.$transaction((tx) => enrollGeneralChannel(tx, workspaceId));
}

test("reads never enroll: general membership comes from write points and the backfill migration", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const alice = await db.user.create({
    data: { displayName: `ea${suffix}`, username: `ea${suffix}` },
  });
  const bob = await db.user.create({
    data: { displayName: `eb${suffix}`, username: `eb${suffix}` },
  });
  // A pre-backfill Workspace: humans and an Agent exist, general does not.
  const workspace = await db.workspace.create({
    data: {
      slug: `enroll-${suffix}`,
      name: "Legacy workspace",
      members: { create: [{ userId: alice.id }, { userId: bob.id }] },
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
        name: "legacy-helper",
        displayName: "Legacy Helper",
        runtimeConfig: {},
      },
    });
    const channels = new PublicChannels(db);
    expect(await channels.list(workspace.id, alice.id)).toEqual([]);

    const migration = (
      await Bun.file(
        new URL(
          "../prisma/migrations/20260915120000_backfill_general_channel/migration.sql",
          import.meta.url,
        ),
      ).text()
    )
      .split("\n")
      .filter((line) => !line.startsWith("--"))
      .join("\n")
      .split(";")
      .filter((part) => part.trim());
    for (const statement of migration) await db.$executeRawUnsafe(statement);
    const general = await db.conversation.findUniqueOrThrow({
      where: { workspaceId_channelName: { workspaceId: workspace.id, channelName: "general" } },
      include: { members: { orderBy: { userId: "asc" } } },
    });
    expect(general.members.map((m) => m.userId ?? m.agentId).sort()).toEqual(
      [alice.id, bob.id, agent.id].sort(),
    );
    expect(await channels.list(workspace.id, bob.id)).toEqual([
      {
        id: general.id,
        name: "general",
        joined: true,
        archived: false,
        muted: false,
        unreadCount: 0,
        mentioned: false,
        lastMessage: null,
        members: expect.any(Array),
        hidden: false,
        pinned: false,
        pinSortOrder: null,
      },
    ]);

    // Re-running the backfill is a no-op.
    for (const statement of migration) await db.$executeRawUnsafe(statement);
    expect(await db.conversationMember.count({ where: { conversationId: general.id } })).toBe(3);

    // A membership row written outside the write points is not repaired by reads.
    const carol = await db.user.create({
      data: { displayName: `ec${suffix}`, username: `ec${suffix}` },
    });
    try {
      await db.workspaceMembership.create({
        data: { workspaceId: workspace.id, userId: carol.id },
      });
      expect(await channels.list(workspace.id, carol.id)).toEqual([
        {
          id: general.id,
          name: "general",
          joined: false,
          archived: false,
          muted: false,
          unreadCount: 0,
          mentioned: false,
          lastMessage: null,
          members: expect.any(Array),
          hidden: false,
          pinned: false,
          pinSortOrder: null,
        },
      ]);
      await channels.open(workspace.id, carol.id, general.id);
      expect(await db.conversationMember.count({ where: { conversationId: general.id } })).toBe(3);
    } finally {
      await db.user.delete({ where: { id: carol.id } });
    }
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.computer.deleteMany({ where: { ownerId: alice.id } });
    await db.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
    await db.$disconnect();
  }
});

test("Channel roles: creator is channel admin, a plain member cannot archive, promote/demote via setChannelRole, server admin without membership, #general's roles are fixed", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const suffix = crypto.randomUUID().slice(0, 8);
  const creator = await db.user.create({
    data: { displayName: `rc${suffix}`, username: `rc${suffix}` },
  });
  const plainMember = await db.user.create({
    data: { displayName: `rp${suffix}`, username: `rp${suffix}` },
  });
  const serverAdmin = await db.user.create({
    data: { displayName: `ra${suffix}`, username: `ra${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `roles-${suffix}`,
      name: "Channel roles",
      members: {
        create: [
          { userId: creator.id },
          { userId: plainMember.id },
          // Never joins the channel: proves `server_role` basis needs no membership.
          { userId: serverAdmin.id, role: "admin" },
        ],
      },
    },
  });
  try {
    const channels = new PublicChannels(
      db,
      new RedisMessageRequestIdempotency(redis),
      quietCentrifugo(),
    );
    await enrollGeneral(db, workspace.id);

    // The creator is the channel's own admin: `channelRole` "admin", basis
    // "channel_role", and every admin capability except on `#general`.
    const channel = await channels.create(workspace.id, creator.id, "roles-eng");
    await channels.join(workspace.id, plainMember.id, channel.id);
    const creatorView = await channels.members(workspace.id, { userId: creator.id }, channel.id);
    expect(creatorView.channelRole).toBe("admin");
    expect(creatorView.channelAdminBasis).toBe("channel_role");
    expect(creatorView.channelCapabilities).toMatchObject({
      update: true,
      archive: true,
      unarchive: true,
      remove_member: true,
      manage_roles: true,
    });
    const creatorRow = creatorView.humans.find((human) => human.id === creator.id);
    expect(creatorRow).toMatchObject({ channelRole: "admin", channelAdminBasis: "channel_role" });

    // A plain member (no admin basis at all) sees no admin capabilities and cannot manage
    // roles or archive.
    const plainView = await channels.members(workspace.id, { userId: plainMember.id }, channel.id);
    expect(plainView.channelRole).toBe("member");
    expect(plainView.channelAdminBasis).toBeUndefined();
    expect(plainView.channelCapabilities).toMatchObject({
      update: false,
      archive: false,
      unarchive: false,
      remove_member: false,
      manage_roles: false,
    });
    await expect(
      channels.setChannelRole(
        workspace.id,
        plainMember.id,
        channel.id,
        { userId: plainMember.id },
        "admin",
      ),
    ).rejects.toThrow("ACCESS_DENIED");

    // Promoting via `setChannelRole` grants channel-admin authority; demoting revokes it.
    await channels.setChannelRole(
      workspace.id,
      creator.id,
      channel.id,
      { userId: plainMember.id },
      "admin",
    );
    const promotedView = await channels.members(
      workspace.id,
      { userId: plainMember.id },
      channel.id,
    );
    expect(promotedView.channelRole).toBe("admin");
    expect(promotedView.channelAdminBasis).toBe("channel_role");
    expect(promotedView.channelCapabilities.archive).toBe(true);

    await channels.setChannelRole(
      workspace.id,
      creator.id,
      channel.id,
      { userId: plainMember.id },
      "member",
    );
    const demotedView = await channels.members(
      workspace.id,
      { userId: plainMember.id },
      channel.id,
    );
    expect(demotedView.channelRole).toBe("member");
    expect(demotedView.channelAdminBasis).toBeUndefined();
    expect(demotedView.channelCapabilities.archive).toBe(false);

    // `server_role` basis needs no membership: `serverAdmin` never joined this channel but
    // still reports full admin capabilities.
    const serverAdminView = await channels.members(
      workspace.id,
      { userId: serverAdmin.id },
      channel.id,
    );
    expect(serverAdminView.channelRole).toBeUndefined();
    expect(serverAdminView.channelAdminBasis).toBe("server_role");
    expect(serverAdminView.channelCapabilities).toMatchObject({
      update: true,
      archive: true,
      unarchive: true,
      remove_member: true,
      manage_roles: true,
    });

    // `#general`'s roles are fixed: nobody can be its channel admin, `setChannelRole` always
    // rejects, and even a server admin's admin capabilities are unavailable there.
    const general = await db.conversation.findUniqueOrThrow({
      where: { workspaceId_channelName: { workspaceId: workspace.id, channelName: "general" } },
    });
    await expect(
      channels.setChannelRole(
        workspace.id,
        serverAdmin.id,
        general.id,
        { userId: plainMember.id },
        "admin",
      ),
    ).rejects.toThrow("CONFLICT");
    const generalServerAdminView = await channels.members(
      workspace.id,
      { userId: serverAdmin.id },
      general.id,
    );
    expect(generalServerAdminView.channelAdminBasis).toBe("server_role");
    // A server admin edits #general's description (never its name) and nothing else.
    expect(generalServerAdminView.channelCapabilities).toMatchObject({
      update: true,
      archive: false,
      unarchive: false,
      remove_member: false,
      manage_roles: false,
      leave: false,
    });
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.deleteMany({
      where: { id: { in: [creator.id, plainMember.id, serverAdmin.id] } },
    });
    await db.$disconnect();
    redis.close();
  }
});

test("Agent channel info exposes a bound Project scoped to the Agent's own Workspace; an unbound channel omits it, and another Workspace's Project never leaks", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await db.user.create({
    data: { displayName: `pio${suffix}`, username: `pio${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `proj-info-${suffix}`,
      name: "Project channel info",
      members: { create: { userId: owner.id, role: "owner" } },
    },
  });
  const foreignWorkspace = await db.workspace.create({
    data: { slug: `proj-info-foreign-${suffix}`, name: "Foreign" },
  });
  try {
    const computer = await db.computer.create({
      data: { ownerId: owner.id, machineId: crypto.randomUUID() },
    });
    const agent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: owner.id,
        computerId: computer.id,
        name: `piagent${suffix}`,
        displayName: "Agent",
        role: "member",
        runtimeConfig: {},
      },
    });
    await enrollGeneral(db, workspace.id);

    const boundProject = await db.project.create({
      data: {
        workspaceId: workspace.id,
        name: "Launch",
        slug: `launch-${suffix}`,
        githubFullName: "acme/launch",
        githubHtmlUrl: "https://github.com/acme/launch",
      },
    });
    const unboundProject = await db.project.create({
      data: { workspaceId: workspace.id, name: "Docs", slug: `docs-${suffix}` },
    });
    const foreignProject = await db.project.create({
      data: { workspaceId: foreignWorkspace.id, name: "Foreign", slug: `foreign-${suffix}` },
    });

    // A Project discussion group: bound to `boundProject`, which itself has a
    // GitHub repository.
    const withGithub = await db.conversation.create({
      data: {
        workspaceId: workspace.id,
        channelName: `withgithub${suffix.slice(0, 6)}`,
        projectId: boundProject.id,
        members: { create: { agentId: agent.id } },
      },
    });
    // Bound to a Project with no GitHub repository.
    const noGithub = await db.conversation.create({
      data: {
        workspaceId: workspace.id,
        channelName: `nogithub${suffix.slice(0, 6)}`,
        projectId: unboundProject.id,
        members: { create: { agentId: agent.id } },
      },
    });
    // An ordinary channel: no Project at all.
    const plain = await db.conversation.create({
      data: {
        workspaceId: workspace.id,
        channelName: `plain${suffix.slice(0, 6)}`,
        members: { create: { agentId: agent.id } },
      },
    });
    // Data that should not be reachable through any authorized flow (`PublicChannels.create`
    // validates the Project's Workspace before assigning it): a channel whose `projectId` points
    // at another Workspace's Project. The server must still never surface it.
    const crossWorkspace = await db.conversation.create({
      data: {
        workspaceId: workspace.id,
        channelName: `cross${suffix.slice(0, 6)}`,
        projectId: foreignProject.id,
        members: { create: { agentId: agent.id } },
      },
    });

    const manage = new AgentChannelManagement(db, {
      snapshot: async () => {
        throw new Error("no live display data in this test");
      },
      snapshotMany: async () => {
        throw new Error("no live display data in this test");
      },
    });

    const withGithubInfo = await manage.info(workspace.id, agent.id, `#${withGithub.channelName}`);
    expect(withGithubInfo.project).toEqual({
      id: boundProject.id,
      name: "Launch",
      slug: `launch-${suffix}`,
      githubFullName: "acme/launch",
      githubHtmlUrl: "https://github.com/acme/launch",
    });

    const noGithubInfo = await manage.info(workspace.id, agent.id, `#${noGithub.channelName}`);
    expect(noGithubInfo.project).toEqual({
      id: unboundProject.id,
      name: "Docs",
      slug: `docs-${suffix}`,
    });

    const plainInfo = await manage.info(workspace.id, agent.id, `#${plain.channelName}`);
    expect(plainInfo.project).toBeUndefined();

    const crossWorkspaceInfo = await manage.info(
      workspace.id,
      agent.id,
      `#${crossWorkspace.channelName}`,
    );
    expect(crossWorkspaceInfo.project).toBeUndefined();
  } finally {
    await db.workspace.deleteMany({ where: { id: { in: [workspace.id, foreignWorkspace.id] } } });
    await db.computer.deleteMany({ where: { ownerId: owner.id } });
    await db.user.deleteMany({ where: { id: owner.id } });
    await db.$disconnect();
  }
});

test("channel unread: list counts other-authored top-level messages past the cursor, markRead advances monotonically, threads never count, join/addMembers seed the cursor", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID();
  const alice = await db.user.create({
    data: { displayName: `alice-${suffix}`, username: `alice-${suffix}` },
  });
  const bob = await db.user.create({
    data: { displayName: `bob-${suffix}`, username: `bob-${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: suffix,
      name: "Unread",
      members: { create: [{ userId: alice.id }, { userId: bob.id }] },
    },
  });
  try {
    await enrollGeneral(db, workspace.id);
    const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
    const channels = new PublicChannels(
      db,
      new RedisMessageRequestIdempotency(redis),
      quietCentrifugo(),
    );
    const engineering = await channels.create(workspace.id, alice.id, "unread-eng");

    // Joining seeds the cursor at the channel's current end: no backlog badge.
    await channels.join(workspace.id, alice.id, engineering.id);
    await channels.join(workspace.id, bob.id, engineering.id);
    const send = (userId: string, body: string, threadRootId?: string) =>
      channels.send({
        workspaceId: workspace.id,
        userId,
        channelId: engineering.id,
        body,
        idempotencyKey: crypto.randomUUID(),
        ...(threadRootId ? { threadRootId } : {}),
      });

    const root = await send(alice.id, "root from alice");
    // bob's view: alice's top-level message is unread; alice's own never is.
    let list = await channels.list(workspace.id, bob.id);
    expect(list.find((c) => c.id === engineering.id)?.unreadCount).toBe(1);
    list = await channels.list(workspace.id, alice.id);
    expect(list.find((c) => c.id === engineering.id)?.unreadCount).toBe(0);

    // A thread reply never adds channel unread for bob.
    await send(alice.id, "thread reply", root.id);
    list = await channels.list(workspace.id, bob.id);
    expect(list.find((c) => c.id === engineering.id)?.unreadCount).toBe(1);

    // A second top-level message bumps the count to 2.
    await send(alice.id, "second top-level");
    list = await channels.list(workspace.id, bob.id);
    expect(list.find((c) => c.id === engineering.id)?.unreadCount).toBe(2);

    // markRead clears it; a stale boundary cannot move the cursor backwards.
    await channels.markRead(workspace.id, bob.id, engineering.id, 10_000);
    list = await channels.list(workspace.id, bob.id);
    expect(list.find((c) => c.id === engineering.id)?.unreadCount).toBe(0);
    await send(alice.id, "third after read");
    await channels.markRead(workspace.id, bob.id, engineering.id, 1);
    list = await channels.list(workspace.id, bob.id);
    expect(list.find((c) => c.id === engineering.id)?.unreadCount).toBe(1);

    // A non-member has no unread badge even though history is readable.
    const carol = await db.user.create({
      data: { displayName: `carol-${suffix}`, username: `carol-${suffix}` },
    });
    await db.workspaceMembership.create({
      data: { workspaceId: workspace.id, userId: carol.id },
    });
    list = await channels.list(workspace.id, carol.id);
    expect(list.find((c) => c.id === engineering.id)?.joined).toBe(false);
    expect(list.find((c) => c.id === engineering.id)?.unreadCount).toBe(0);

    // A newly added member starts already-read: addMembers seeds the cursor at the end.
    await channels.addMembers(workspace.id, { userId: alice.id }, engineering.id, {
      userIds: [carol.id],
      agentIds: [],
    });
    list = await channels.list(workspace.id, carol.id);
    expect(list.find((c) => c.id === engineering.id)?.unreadCount).toBe(0);

    // Re-adding an already-active member is a no-op: it must not reset a cursor they had
    // advanced, or an admin re-running `channel add-member` would re-badge read history.
    await channels.markRead(workspace.id, carol.id, engineering.id, 10_000);
    await send(alice.id, "unread for carol");
    expect(
      (await channels.list(workspace.id, carol.id)).find((c) => c.id === engineering.id)
        ?.unreadCount,
    ).toBe(1);
    await channels.addMembers(workspace.id, { userId: alice.id }, engineering.id, {
      userIds: [carol.id],
      agentIds: [],
    });
    expect(
      (await channels.list(workspace.id, carol.id)).find((c) => c.id === engineering.id)
        ?.unreadCount,
    ).toBe(1);
  } finally {
    await db.workspace.deleteMany({ where: { id: workspace.id } });
    await db.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
    await db.$disconnect();
  }
});

test("channel unread: marking unread counts from the newest message someone else sent, and a read past it clears it", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID();
  const alice = await db.user.create({
    data: { displayName: `alice-${suffix}`, username: `alice-${suffix}` },
  });
  const bob = await db.user.create({
    data: { displayName: `bob-${suffix}`, username: `bob-${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: suffix,
      name: "Unread marker",
      members: { create: [{ userId: alice.id }, { userId: bob.id }] },
    },
  });
  try {
    await enrollGeneral(db, workspace.id);
    const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
    const channels = new PublicChannels(
      db,
      new RedisMessageRequestIdempotency(redis),
      quietCentrifugo(),
    );
    const channel = await channels.create(workspace.id, alice.id, "unread-marker");
    await channels.join(workspace.id, alice.id, channel.id);
    await channels.join(workspace.id, bob.id, channel.id);
    const send = (userId: string, body: string) =>
      channels.send({
        workspaceId: workspace.id,
        userId,
        channelId: channel.id,
        body,
        idempotencyKey: crypto.randomUUID(),
      });
    const unreadFor = async (userId: string) =>
      (await channels.list(workspace.id, userId)).find((c) => c.id === channel.id)?.unreadCount;

    await send(alice.id, "one");
    await send(alice.id, "two");
    await channels.markRead(workspace.id, bob.id, channel.id, 10_000);
    expect(await unreadFor(bob.id)).toBe(0);

    // Marked unread: the newest message counts again although the cursor is past it.
    await channels.setUserUnread(workspace.id, bob.id, channel.id, true);
    expect(await unreadFor(bob.id)).toBe(1);
    // Newer messages add to it; the viewer's own message still never counts.
    await send(alice.id, "three");
    await send(bob.id, "bob's own");
    expect(await unreadFor(bob.id)).toBe(2);

    // Reading through the end clears the marker.
    await channels.markRead(workspace.id, bob.id, channel.id, 10_000);
    expect(await unreadFor(bob.id)).toBe(0);

    // Clearing the marker by hand leaves only what is past the cursor.
    await channels.setUserUnread(workspace.id, bob.id, channel.id, true);
    await channels.setUserUnread(workspace.id, bob.id, channel.id, false);
    expect(await unreadFor(bob.id)).toBe(0);

    // With the viewer's own message newest, marking reopens the newest message someone else sent.
    await send(bob.id, "bob again");
    expect(await channels.setUserUnread(workspace.id, bob.id, channel.id, true)).toEqual({
      unread: true,
    });
    expect(await unreadFor(bob.id)).toBe(1);

    // A channel where only the viewer has spoken has nothing to mark.
    const solo = await channels.create(workspace.id, bob.id, "unread-marker-solo");
    await channels.join(workspace.id, bob.id, solo.id);
    await channels.send({
      workspaceId: workspace.id,
      userId: bob.id,
      channelId: solo.id,
      body: "only bob",
      idempotencyKey: crypto.randomUUID(),
    });
    expect(await channels.setUserUnread(workspace.id, bob.id, solo.id, true)).toEqual({
      unread: false,
    });
  } finally {
    await db.workspace.deleteMany({ where: { id: workspace.id } });
    await db.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
    await db.$disconnect();
  }
});

test("a thread's root author starts following that thread, so later replies reach them", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const suffix = crypto.randomUUID();
  const alice = await db.user.create({
    data: { displayName: `ra${suffix.slice(0, 8)}`, username: `ra${suffix.slice(0, 8)}` },
  });
  const bob = await db.user.create({
    data: { displayName: `rb${suffix.slice(0, 8)}`, username: `rb${suffix.slice(0, 8)}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `root-follow-${suffix}`,
      name: "Root author follow",
      members: { create: [{ userId: alice.id }, { userId: bob.id }] },
    },
  });
  try {
    const channels = new PublicChannels(
      db,
      new RedisMessageRequestIdempotency(redis),
      quietCentrifugo(),
    );
    const channel = await channels.create(workspace.id, alice.id, "rootfollow");
    await channels.join(workspace.id, bob.id, channel.id);

    const root = await channels.send({
      workspaceId: workspace.id,
      userId: alice.id,
      channelId: channel.id,
      idempotencyKey: crypto.randomUUID(),
      body: "root by alice",
    });
    const followed = async (userId: string) => {
      const member = await db.conversationMember.findUniqueOrThrow({
        where: { conversationId_userId: { conversationId: channel.id, userId } },
        select: { id: true },
      });
      return db.threadFollow.findUnique({
        where: { memberId_rootMessageId: { memberId: member.id, rootMessageId: root.id } },
      });
    };
    // A top-level root message on its own enrolls nobody: replies are what make a thread.
    expect(await followed(alice.id)).toBeNull();

    await channels.send({
      workspaceId: workspace.id,
      userId: bob.id,
      channelId: channel.id,
      idempotencyKey: crypto.randomUUID(),
      body: "reply by bob",
      threadRootId: root.id,
    });

    // The replier follows the thread, and so does the author of the message being replied to:
    // without that second enrollment a reply under someone's own message would never reach them,
    // because a thread reply is not a parent-channel post and notifies followers only.
    expect(await followed(bob.id)).not.toBeNull();
    expect(await followed(alice.id)).not.toBeNull();

    // An explicit unfollow is a decision: a later reply must not silently re-enroll the root
    // author back into the thread.
    await channels.setUserThreadFollowed(workspace.id, alice.id, channel.id, root.id, false);
    await channels.send({
      workspaceId: workspace.id,
      userId: bob.id,
      channelId: channel.id,
      idempotencyKey: crypto.randomUUID(),
      body: "second reply by bob",
      threadRootId: root.id,
    });
    expect(await followed(alice.id)).toBeNull();
  } finally {
    await db.workspace.deleteMany({ where: { id: workspace.id } });
    await db.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
    await db.$disconnect();
  }
});

test("an Agent's thread reply enrolls exactly the members its stored mention rows name; an @handle in code or a link label enrolls nobody", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const suffix = crypto.randomUUID().slice(0, 8);
  const alice = await db.user.create({
    data: { displayName: `ea${suffix}`, username: `ea${suffix}` },
  });
  const bob = await db.user.create({
    data: { displayName: `eb${suffix}`, username: `eb${suffix}` },
  });
  const carol = await db.user.create({
    data: { displayName: `ec${suffix}`, username: `ec${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `agent-enroll-${suffix}`,
      name: "Agent reply enrollment",
      members: {
        create: [{ userId: alice.id, role: "owner" }, { userId: bob.id }, { userId: carol.id }],
      },
    },
  });
  try {
    const helper = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: alice.id,
        name: "helper",
        displayName: "Helper",
        runtimeConfig: {},
      },
    });
    await enrollGeneral(db, workspace.id);
    const channels = new PublicChannels(
      db,
      new RedisMessageRequestIdempotency(redis),
      quietCentrifugo(),
    );
    const repo = new PrismaDirectConversationRepository(db);
    const general = (await channels.list(workspace.id, alice.id))[0]!;
    const root = await channels.send({
      workspaceId: workspace.id,
      userId: alice.id,
      channelId: general.id,
      idempotencyKey: crypto.randomUUID(),
      body: "root by alice",
    });
    const reply = await repo.sendAgentMessage(
      general.id,
      helper.id,
      `@${bob.username} please look; not \`@${carol.username}\` or [ask @${carol.username}](https://example.com)`,
      undefined,
      root.id,
    );
    const followers = await db.threadFollow.findMany({
      where: { rootMessageId: root.id },
      select: { member: { select: { userId: true, agentId: true } } },
    });
    // The reply's mention rows name bob alone, and enrollment follows them: the replying Agent,
    // the root author (first reply) and bob. Carol, written only in code and in a link label,
    // is no mention and no follower.
    expect(
      (await db.messageMention.findMany({ where: { messageId: reply.id } })).map(
        (mention) => mention.actorId,
      ),
    ).toEqual([bob.id]);
    expect(followers.map(({ member }) => member.userId ?? member.agentId).sort()).toEqual(
      [alice.id, bob.id, helper.id].sort(),
    );
  } finally {
    await db.workspace.deleteMany({ where: { id: workspace.id } });
    await db.user.deleteMany({ where: { id: { in: [alice.id, bob.id, carol.id] } } });
    await db.$disconnect();
    redis.close();
  }
});

test("a thread reply from a person or an Agent enrolls its sender, the members it mentions or binds, and the root author on the first reply", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const suffix = crypto.randomUUID().slice(0, 8);
  const alice = await db.user.create({
    data: { displayName: `fa${suffix}`, username: `fa${suffix}` },
  });
  const bob = await db.user.create({
    data: { displayName: `fb${suffix}`, username: `fb${suffix}` },
  });
  const carol = await db.user.create({
    data: { displayName: `fc${suffix}`, username: `fc${suffix}` },
  });
  const dave = await db.user.create({
    data: { displayName: `fd${suffix}`, username: `fd${suffix}` },
  });
  const erin = await db.user.create({
    data: { displayName: `fe${suffix}`, username: `fe${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `reply-enroll-${suffix}`,
      name: "Thread reply enrollment",
      members: {
        create: [
          { userId: alice.id, role: "owner" },
          { userId: bob.id },
          { userId: carol.id },
          { userId: dave.id },
          { userId: erin.id },
        ],
      },
    },
  });
  try {
    const agent = (name: string) =>
      db.agent.create({
        data: {
          workspaceId: workspace.id,
          ownerId: alice.id,
          name,
          displayName: name,
          runtimeConfig: {},
        },
      });
    const helper = await agent("helper");
    const scout = await agent("scout");
    await enrollGeneral(db, workspace.id);
    const channels = new PublicChannels(
      db,
      new RedisMessageRequestIdempotency(redis),
      quietCentrifugo(),
    );
    const repo = new PrismaDirectConversationRepository(db);
    const general = (await channels.list(workspace.id, alice.id))[0]!;
    const followers = async (rootMessageId: string) =>
      (
        await db.threadFollow.findMany({
          where: { rootMessageId },
          select: { member: { select: { userId: true, agentId: true } } },
        })
      )
        .map(({ member }) => member.userId ?? member.agentId)
        .sort();

    // A person's reply: the replier, the member it @mentions, and the root author (first reply).
    const root = await channels.send({
      workspaceId: workspace.id,
      userId: alice.id,
      channelId: general.id,
      idempotencyKey: crypto.randomUUID(),
      body: "root by alice",
    });
    await channels.send({
      workspaceId: workspace.id,
      userId: bob.id,
      channelId: general.id,
      idempotencyKey: crypto.randomUUID(),
      body: `@${carol.username} can you look?`,
      threadRootId: root.id,
    });
    expect(await followers(root.id)).toEqual([alice.id, bob.id, carol.id].sort());

    // An Agent's later reply adds itself, the member its body @mentions and the one its
    // `--mention` binding names without the body writing the handle.
    await repo.sendAgentMessage(
      general.id,
      helper.id,
      `@${dave.username} and scout, please take this.`,
      [],
      root.id,
      [{ type: "agent", id: scout.id, name: "scout" }],
    );
    expect(await followers(root.id)).toEqual(
      [alice.id, bob.id, carol.id, dave.id, helper.id, scout.id].sort(),
    );

    // An Agent's first reply under a person's message enrolls that person too, and a person's
    // reply that mentions themself enrolls them once.
    const erinRoot = await channels.send({
      workspaceId: workspace.id,
      userId: erin.id,
      channelId: general.id,
      idempotencyKey: crypto.randomUUID(),
      body: "root by erin",
    });
    await repo.sendAgentMessage(general.id, scout.id, "On it.", [], erinRoot.id);
    await channels.send({
      workspaceId: workspace.id,
      userId: dave.id,
      channelId: general.id,
      idempotencyKey: crypto.randomUUID(),
      body: `@${dave.username} noting this for myself`,
      threadRootId: erinRoot.id,
    });
    expect(await followers(erinRoot.id)).toEqual([dave.id, erin.id, scout.id].sort());
  } finally {
    await db.workspace.deleteMany({ where: { id: workspace.id } });
    await db.user.deleteMany({
      where: { id: { in: [alice.id, bob.id, carol.id, dave.id, erin.id] } },
    });
    await db.$disconnect();
    redis.close();
  }
});

test("a channel member can list and unfollow Agents following a thread; a private Agent is never a channel follower", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const suffix = crypto.randomUUID().slice(0, 8);
  const alice = await db.user.create({
    data: { displayName: `fa${suffix}`, username: `fa${suffix}` },
  });
  const bob = await db.user.create({
    data: { displayName: `fb${suffix}`, username: `fb${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `follow-agents-${suffix}`,
      name: "Following agents",
      members: {
        create: [{ userId: alice.id, role: "owner" }, { userId: bob.id }],
      },
    },
  });
  try {
    const computer = await db.computer.create({
      data: { ownerId: alice.id, machineId: crypto.randomUUID() },
    });
    const helper = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: alice.id,
        computerId: computer.id,
        name: "helper",
        displayName: "Helper",
        runtimeConfig: {},
      },
    });
    // A private Agent is never an active channel member — not even in #general. It
    // cannot be @mentioned there (mentions resolve against active members), is never delivered a
    // channel reply, and so never becomes a thread follower. Only the public `helper` can appear
    // in any follower list below; `scout` is here to prove it stays absent even for its creator.
    const scout = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: alice.id,
        computerId: computer.id,
        name: "scout",
        displayName: "Scout",
        visibility: "private",
        runtimeConfig: {},
      },
    });
    await enrollGeneral(db, workspace.id);
    const channels = new PublicChannels(
      db,
      new RedisMessageRequestIdempotency(redis),
      quietCentrifugo(),
    );
    const general = (await channels.list(workspace.id, alice.id))[0]!;
    // The membership rule, pinned directly, so the absences below have one named cause:
    // #general enrolls every public Agent and no private one.
    expect(
      (
        await db.conversationMember.findMany({
          where: { conversationId: general.id, agentId: { in: [helper.id, scout.id] } },
          select: { agentId: true },
        })
      ).map((member) => member.agentId),
    ).toEqual([helper.id]);
    const root = await channels.send({
      workspaceId: workspace.id,
      userId: alice.id,
      channelId: general.id,
      idempotencyKey: crypto.randomUUID(),
      body: "please both take this",
    });
    await channels.send({
      workspaceId: workspace.id,
      userId: alice.id,
      channelId: general.id,
      idempotencyKey: crypto.randomUUID(),
      body: "@helper @scout please follow",
      threadRootId: root.id,
    });

    const aliceView = await channels.threadFollowingAgents(
      workspace.id,
      alice.id,
      general.id,
      root.id,
    );
    expect(aliceView.canUnfollow).toBe(true);
    expect(aliceView.agents.map((agent) => agent.id)).toEqual([helper.id]);

    const bobView = await channels.threadFollowingAgents(workspace.id, bob.id, general.id, root.id);
    expect(bobView.canUnfollow).toBe(true);
    expect(bobView.agents.map((agent) => agent.id)).toEqual([helper.id]);

    await expect(
      channels.unfollowAgentFromThread(workspace.id, bob.id, general.id, root.id, scout.id),
    ).rejects.toThrow("NOT_FOUND");

    await db.conversationMember.update({
      where: { conversationId_userId: { conversationId: general.id, userId: bob.id } },
      data: { leftAt: new Date() },
    });
    const leftView = await channels.threadFollowingAgents(
      workspace.id,
      bob.id,
      general.id,
      root.id,
    );
    expect(leftView.canUnfollow).toBe(false);
    expect(leftView.agents.map((agent) => agent.id)).toEqual([helper.id]);
    await expect(
      channels.unfollowAgentFromThread(workspace.id, bob.id, general.id, root.id, helper.id),
    ).rejects.toThrow("ACCESS_DENIED");

    expect(
      await channels.unfollowAgentFromThread(
        workspace.id,
        alice.id,
        general.id,
        root.id,
        helper.id,
      ),
    ).toEqual({ followed: false });
    // `helper` was the only follower alice could see (see the membership-rule note above), so
    // unfollowing it leaves the list empty — the private `scout` is not a hidden fallback.
    expect(
      (
        await channels.threadFollowingAgents(workspace.id, alice.id, general.id, root.id)
      ).agents.map((agent) => agent.id),
    ).toEqual([]);
  } finally {
    await db.workspace.deleteMany({ where: { id: workspace.id } });
    await db.computer.deleteMany({ where: { ownerId: alice.id } });
    await db.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
    await db.$disconnect();
    redis.close();
  }
});

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
    expect(await recipientsOf(mentioned.id)).toEqual([bob.id]);
    expect(await pushSubscriptions.notificationForRecipient(mentioned.id, bob.id)).not.toBeNull();

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

test("pins keep one order across the member's channels and DMs: a new pin goes last, a pin made again after unpinning goes last", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const suffix = crypto.randomUUID();
  const alice = await db.user.create({
    data: { displayName: `pa${suffix.slice(0, 8)}`, username: `pa${suffix.slice(0, 8)}` },
  });
  const workspace = await db.workspace.create({
    data: { slug: suffix, name: "Pins", members: { create: [{ userId: alice.id }] } },
  });
  try {
    const computer = await db.computer.create({
      data: { ownerId: alice.id, machineId: crypto.randomUUID() },
    });
    const helper = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: alice.id,
        computerId: computer.id,
        name: "helper",
        displayName: "Helper",
        runtimeConfig: {},
      },
    });
    const channels = new PublicChannels(db, new RedisMessageRequestIdempotency(redis));
    const directs = new DirectConversations(db);
    const ops = await channels.create(workspace.id, alice.id, "ops");
    const eng = await channels.create(workspace.id, alice.id, "eng");
    const { conversationId: helperDm } = await directs.open(workspace.id, alice.id, {
      agentId: helper.id,
    });

    /** The member's pins as one list, the way the sidebar's Pinned section reads them. */
    const pinned = async () => {
      const [channelRows, preferences] = await Promise.all([
        channels.list(workspace.id, alice.id),
        directs.list(workspace.id, alice.id),
      ]);
      return [
        ...channelRows
          .filter((channel) => channel.pinned)
          .map((channel) => ({ name: channel.name, order: channel.pinSortOrder! })),
        ...preferences.pinned.map((pin) => ({ name: "@helper", order: pin.sortOrder })),
      ]
        .sort((left, right) => left.order - right.order)
        .map((pin) => pin.name);
    };

    await channels.setUserPinned(workspace.id, alice.id, ops.id, true);
    await directs.setPinned(workspace.id, alice.id, helperDm, true);
    await channels.setUserPinned(workspace.id, alice.id, eng.id, true);
    expect(await pinned()).toEqual(["ops", "@helper", "eng"]);

    // Pinning what is already pinned keeps its place.
    await channels.setUserPinned(workspace.id, alice.id, ops.id, true);
    expect(await pinned()).toEqual(["ops", "@helper", "eng"]);

    // Unpinning and pinning again puts it after every other pin, never on a slot another pin holds.
    await channels.setUserPinned(workspace.id, alice.id, ops.id, false);
    await channels.setUserPinned(workspace.id, alice.id, ops.id, true);
    expect(await pinned()).toEqual(["@helper", "eng", "ops"]);
    const orders = (await channels.list(workspace.id, alice.id))
      .filter((channel) => channel.pinned)
      .map((channel) => channel.pinSortOrder);
    expect(new Set(orders).size).toBe(orders.length);

    // Closing a pinned chat does not take it out of Pinned: the list keeps reporting it.
    await channels.setUserHidden(workspace.id, alice.id, eng.id, true);
    expect(await pinned()).toEqual(["@helper", "eng", "ops"]);
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.computer.deleteMany({ where: { ownerId: alice.id } });
    await db.user.deleteMany({ where: { id: alice.id } });
    await db.$disconnect();
    redis.close();
  }
});

test("arranging a member's pins sets their order in one step, pins what is new, unpins only what it names, and refuses conversations the member is not in", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const suffix = crypto.randomUUID();
  const alice = await db.user.create({
    data: { displayName: `ra${suffix.slice(0, 8)}`, username: `ra${suffix.slice(0, 8)}` },
  });
  const bob = await db.user.create({
    data: { displayName: `rb${suffix.slice(0, 8)}`, username: `rb${suffix.slice(0, 8)}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: suffix,
      name: "Pin order",
      members: { create: [{ userId: alice.id }, { userId: bob.id }] },
    },
  });
  try {
    const computer = await db.computer.create({
      data: { ownerId: alice.id, machineId: crypto.randomUUID() },
    });
    const helper = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: alice.id,
        computerId: computer.id,
        name: "helper",
        displayName: "Helper",
        runtimeConfig: {},
      },
    });
    const channels = new PublicChannels(db, new RedisMessageRequestIdempotency(redis));
    const directs = new DirectConversations(db);
    const ops = await channels.create(workspace.id, alice.id, "ops");
    const eng = await channels.create(workspace.id, alice.id, "eng");
    const bobsOwn = await channels.create(workspace.id, bob.id, "bobs");
    const { conversationId: helperDm } = await directs.open(workspace.id, alice.id, {
      agentId: helper.id,
    });
    const pinned = async () => {
      const [channelRows, preferences] = await Promise.all([
        channels.list(workspace.id, alice.id),
        directs.list(workspace.id, alice.id),
      ]);
      return [
        ...channelRows
          .filter((channel) => channel.pinned)
          .map((channel) => ({ name: channel.name, order: channel.pinSortOrder! })),
        ...preferences.pinned.map((pin) => ({ name: "@helper", order: pin.sortOrder })),
      ]
        .sort((left, right) => left.order - right.order)
        .map((pin) => pin.name);
    };

    await channels.setUserPinned(workspace.id, alice.id, ops.id, true);
    // A new pin dropped at the top, ahead of the existing one.
    await arrangeConversationPins(db, workspace.id, alice.id, {
      pins: [
        { kind: "direct", conversationId: helperDm },
        { kind: "channel", channelId: ops.id },
      ],
      unpinned: [],
    });
    expect(await pinned()).toEqual(["@helper", "ops"]);

    // Reordered, with one more pinned in between and one dragged out (unpinned).
    await arrangeConversationPins(db, workspace.id, alice.id, {
      pins: [
        { kind: "channel", channelId: eng.id },
        { kind: "direct", conversationId: helperDm },
      ],
      unpinned: [{ kind: "channel", channelId: ops.id }],
    });
    expect(await pinned()).toEqual(["eng", "@helper"]);

    // A pin the arranged list does not know about (made in another tab) is kept, after the rest.
    await channels.setUserPinned(workspace.id, alice.id, ops.id, true);
    await arrangeConversationPins(db, workspace.id, alice.id, {
      pins: [
        { kind: "direct", conversationId: helperDm },
        { kind: "channel", channelId: eng.id },
      ],
      unpinned: [],
    });
    expect(await pinned()).toEqual(["@helper", "eng", "ops"]);

    // A channel Alice never joined cannot be pinned, and the refusal changes nothing.
    const error = await arrangeConversationPins(db, workspace.id, alice.id, {
      pins: [{ kind: "channel", channelId: bobsOwn.id }],
      unpinned: [],
    }).catch((cause: unknown) => cause);
    expect(isAppError(error) && error.code).toBe("ACCESS_DENIED");
    expect(await pinned()).toEqual(["@helper", "eng", "ops"]);

    // Another member's pins are their own.
    await arrangeConversationPins(db, workspace.id, bob.id, { pins: [], unpinned: [] });
    expect(await pinned()).toEqual(["@helper", "eng", "ops"]);

    // Dragging the only arranged row out: the rest close up from the first place.
    await arrangeConversationPins(db, workspace.id, alice.id, {
      pins: [],
      unpinned: [{ kind: "direct", conversationId: helperDm }],
    });
    expect(await pinned()).toEqual(["eng", "ops"]);
    expect(
      (await channels.list(workspace.id, alice.id))
        .filter((channel) => channel.pinned)
        .map((channel) => channel.pinSortOrder),
    ).toEqual([0, 1]);

    // A menu pin and a drag by the same member at the same moment both complete: they wait for
    // each other instead of deadlocking.
    for (let round = 0; round < 15; round += 1) {
      await Promise.all([
        channels.setUserPinned(workspace.id, alice.id, ops.id, round % 2 === 0),
        directs.setPinned(workspace.id, alice.id, helperDm, round % 2 === 1),
        arrangeConversationPins(db, workspace.id, alice.id, {
          pins: [
            { kind: "channel", channelId: ops.id },
            { kind: "channel", channelId: eng.id },
          ],
          unpinned: [],
        }),
      ]);
    }
    // Whichever finished last, the drag left ops and eng pinned, in that order, with no gaps.
    const [channelRows, preferences] = await Promise.all([
      channels.list(workspace.id, alice.id),
      directs.list(workspace.id, alice.id),
    ]);
    const orders = [
      ...channelRows.flatMap((channel) => (channel.pinned ? [channel.pinSortOrder!] : [])),
      ...preferences.pinned.map((pin) => pin.sortOrder),
    ].sort((left, right) => left - right);
    expect(orders).toEqual([...orders.keys()]);
    expect((await pinned()).filter((name) => name !== "@helper")).toEqual(["ops", "eng"]);
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.computer.deleteMany({ where: { ownerId: alice.id } });
    await db.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
    await db.$disconnect();
    redis.close();
  }
});

test("@-completion offers the Workspace's people and public Agents outside the channel, never a member, the viewer, a private or deleted Agent, or another Workspace", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const alice = await db.user.create({
    data: { displayName: `oa${suffix}`, username: `oa${suffix}` },
  });
  const bob = await db.user.create({ data: { username: `ob${suffix}`, displayName: "Bob" } });
  const carol = await db.user.create({
    data: { displayName: `oc${suffix}`, username: `oc${suffix}` },
  });
  const stranger = await db.user.create({
    data: { displayName: `os${suffix}`, username: `os${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: crypto.randomUUID(),
      name: "Outsiders",
      members: { create: [{ userId: alice.id }, { userId: bob.id }, { userId: carol.id }] },
    },
  });
  const other = await db.workspace.create({
    data: {
      slug: crypto.randomUUID(),
      name: "Other",
      members: { create: { userId: stranger.id } },
    },
  });
  try {
    const computer = await db.computer.create({
      data: { ownerId: alice.id, machineId: crypto.randomUUID() },
    });
    const agent = (name: string, extra: object = {}) =>
      db.agent.create({
        data: {
          workspaceId: workspace.id,
          ownerId: alice.id,
          computerId: computer.id,
          name,
          displayName: name,
          description: `${name} helps`,
          runtimeConfig: {},
          ...extra,
        },
      });
    const helper = await agent("helper");
    await agent("mine", { visibility: "private" });
    await agent("gone", { deletedAt: new Date() });
    const member = await agent("member");
    const channels = new PublicChannels(db);
    const triage = await channels.create(workspace.id, alice.id, `outsiders-${suffix}`);
    await channels.addMembers(workspace.id, { userId: alice.id }, triage.id, {
      userIds: [carol.id],
      agentIds: [member.id],
    });

    const outsiders = await channels.mentionOutsiders(workspace.id, alice.id, triage.id);
    expect(outsiders.map((row) => [row.kind, row.id, row.handle, row.label])).toEqual([
      ["user", bob.id, `ob${suffix}`, "Bob"],
      ["agent", helper.id, "helper", "helper"],
    ]);
    expect(outsiders.every((row) => row.outsider)).toBe(true);
    expect(outsiders[1]!.description).toBe("helper helps");

    // Someone who left the channel is outside it again; a viewer outside the channel is never
    // offered to themselves.
    await db.conversationMember.updateMany({
      where: { conversationId: triage.id, userId: carol.id },
      data: { leftAt: new Date() },
    });
    expect(
      (await channels.mentionOutsiders(workspace.id, bob.id, triage.id)).map((row) => row.handle),
    ).toEqual([`oc${suffix}`, "helper"]);
    // Nobody outside the Workspace, and no channel of another Workspace, is answered.
    await expect(channels.mentionOutsiders(workspace.id, stranger.id, triage.id)).rejects.toThrow();
    await expect(channels.mentionOutsiders(other.id, stranger.id, triage.id)).rejects.toThrow();
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.workspace.delete({ where: { id: other.id } });
    await db.computer.deleteMany({ where: { ownerId: alice.id } });
    await db.user.deleteMany({ where: { id: { in: [alice.id, bob.id, carol.id, stranger.id] } } });
    await db.$disconnect();
  }
});

test("@-completion scores count only the viewer's own mentions in the channel, thread replies included", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const suffix = crypto.randomUUID().slice(0, 8);
  const [alice, bob, carol, dana] = await Promise.all(
    ["ma", "mb", "mc", "md"].map((prefix) =>
      db.user.create({
        data: { displayName: `${prefix}${suffix}`, username: `${prefix}${suffix}` },
      }),
    ),
  );
  const workspace = await db.workspace.create({
    data: {
      slug: `mentions-${suffix}`,
      name: "Mentions",
      members: { create: [alice!, bob!, carol!].map((user) => ({ userId: user.id })) },
    },
  });
  try {
    await enrollGeneral(db, workspace.id);
    // Dana joins the Workspace after enrollment: she can read #general without a member row.
    await db.workspaceMembership.create({ data: { workspaceId: workspace.id, userId: dana!.id } });
    const channels = new PublicChannels(
      db,
      new RedisMessageRequestIdempotency(redis),
      quietCentrifugo(),
    );
    const general = (await channels.list(workspace.id, alice!.id))[0]!;
    const send = (userId: string, body: string, threadRootId?: string) =>
      channels.send({
        workspaceId: workspace.id,
        userId,
        channelId: general.id,
        idempotencyKey: crypto.randomUUID(),
        body,
        threadRootId,
      });
    const root = await send(alice!.id, `@${bob!.username} can you look?`);
    await send(alice!.id, `@${bob!.username} following up`, root.id);
    // Carol mentions both Alice and Bob: someone else's mention never scores for Alice.
    await send(carol!.id, `@${alice!.username} @${bob!.username} on it`);

    const scores = (mentionables: { handle: string; mentionScore: number }[]) =>
      Object.fromEntries(mentionables.map((entry) => [entry.handle, entry.mentionScore]));
    const bobInTwo = { [alice!.username]: 0, [bob!.username]: 200, [carol!.username]: 0 };
    expect(scores((await channels.open(workspace.id, alice!.id, general.id)).mentionables)).toEqual(
      bobInTwo,
    );
    expect(scores(await channels.mentionDirectory(workspace.id, alice!.id, general.id))).toEqual(
      bobInTwo,
    );
    expect(scores(await channels.mentionDirectory(workspace.id, carol!.id, general.id))).toEqual({
      [alice!.username]: 100,
      [bob!.username]: 100,
      [carol!.username]: 0,
    });
    // A reader with no member row has mentioned no one here.
    expect(
      Object.values(scores((await channels.open(workspace.id, dana!.id, general.id)).mentionables)),
    ).toEqual([0, 0, 0]);
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.deleteMany({
      where: { id: { in: [alice!, bob!, carol!, dana!].map((user) => user.id) } },
    });
    await db.$disconnect();
    redis.close();
  }
});
