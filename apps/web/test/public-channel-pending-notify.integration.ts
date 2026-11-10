import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { RedisClient } from "bun";
import { RedisMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { decodeAgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import { quietCentrifugo, withPublishBatch } from "./helpers/fake-centrifugo";

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
    // One outsider delivery: this Workspace never switched the Memory Agent on.
    expect(await db.agentMessageDelivery.count({ where: { messageId: sent.id } })).toBe(1);
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
