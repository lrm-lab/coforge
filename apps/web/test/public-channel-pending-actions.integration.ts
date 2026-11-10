import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { RedisClient } from "bun";
import { RedisMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { SendDirectMessage } from "#src/server/conversations/direct-message.server";
import {
  notifyAgentMentionTargets,
  refuseAgentMentionAdds,
  pendingMentionActionsForAgent,
} from "#src/server/conversations/pending-mention-actions.server";
import { quietCentrifugo } from "./helpers/fake-centrifugo";

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
