import "./channel-reference-agent-reads.integration";
import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { RedisClient } from "bun";
import { RedisMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { decodeAgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { SendDirectMessage } from "#src/server/conversations/direct-message.server";
import { CentrifugoConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { PrismaAgentRepository } from "#src/server/db/repositories/agent.repositories.server";
import { PrismaWebPushSubscriptionStore } from "#src/server/notifications/prisma-web-push-subscriptions.server";
import { enrollGeneral } from "./helpers/general-channel-fixture";
import {
  executeAgentSendMessageWithPolicy,
  muteAgentChannel,
  readAgentMessages,
} from "#src/server/agents/agent-messages.server";
import { withPublishBatch } from "./helpers/fake-centrifugo";
import { CHANNEL_MEMBER_CONTEXT, subscriptionsOf } from "./helpers/public-channel-helpers";

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
    let publishOutage = false;
    const channels = new PublicChannels(
      db,
      new RedisMessageRequestIdempotency(redis),
      withPublishBatch({
        publish: async (_channel, payload) => {
          if (publishOutage) {
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
    // A muted human keeps the @mention badge but receives no Web Push.
    expect(
      subscriptionsOf(
        await new PrismaWebPushSubscriptionStore(db).notificationForMessage(reply.messageId),
      ),
    ).toEqual([]);
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
    await channels.setAgentMuted(workspace.id, second.id, "#general", true);
    const start = published.length;
    await channels.send({
      workspaceId: workspace.id,
      userId: user.id,
      channelId: general.id,
      idempotencyKey: crypto.randomUUID(),
      body: "A muted Agent does not hear ordinary chatter",
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
    publishOutage = true;
    await expect(channels.send(retryInput)).rejects.toThrow("controlled publish outage");
    publishOutage = false;
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
