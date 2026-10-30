import { expect, test } from "bun:test";
import { defaultMemoryAgentId } from "./helpers/default-memory-agent-fixture";
import { agentAvatarUrl } from "#src/features/agents/agent-mascot";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { getAgentChannel } from "#src/server/conversations/channel-access.server";
import { enrollGeneralChannel } from "#src/server/conversations/general-channel.server";
import { RedisClient } from "bun";
import { RedisMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import { decodeAgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import { withPublishBatch } from "./helpers/fake-centrifugo";

function enrollGeneral(db: PrismaClient, workspaceId: string) {
  return db.$transaction((tx) => enrollGeneralChannel(tx, workspaceId));
}

test("channel members add humans and Agents; a Workspace member outside the channel cannot; invalid ids are rejected", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await db.user.create({
    data: { displayName: `mo${suffix}`, username: `mo${suffix}` },
  });
  // A plain `member` role who joins the channel; Slack lets any channel member add people.
  const channelMember = await db.user.create({
    data: { displayName: `mc${suffix}`, username: `mc${suffix}` },
  });
  // A plain `member` role who never joins the channel.
  const outsideMember = await db.user.create({
    data: { displayName: `mm${suffix}`, username: `mm${suffix}` },
  });
  const newcomer = await db.user.create({
    data: { displayName: `mn${suffix}`, username: `mn${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `members-${suffix}`,
      name: "Channel membership",
      members: {
        create: [
          { userId: owner.id, role: "owner" },
          { userId: channelMember.id },
          { userId: outsideMember.id },
          { userId: newcomer.id },
        ],
      },
    },
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
        name: "roster-helper",
        displayName: "Roster Helper",
        runtimeConfig: {},
      },
    });
    await enrollGeneral(db, workspace.id);
    const published: ReturnType<typeof decodeAgentMessageDelivery>[] = [];
    const channels = new PublicChannels(
      db,
      new RedisMessageRequestIdempotency(redis),
      withPublishBatch({
        publish: async (_channel, payload) => {
          published.push(decodeAgentMessageDelivery(payload));
        },
        publishJson: async () => {},
        broadcast: async () => {},
      }),
    );

    // A plain Workspace member creates the channel (Slack: any member can create a channel).
    const channel = await channels.create(workspace.id, channelMember.id, "roster");
    const memoryId = await defaultMemoryAgentId(db, workspace.id);
    await channels.join(workspace.id, owner.id, channel.id);

    // A Workspace member who is NOT in the channel may still read it, but cannot add members.
    const outsideView = await channels.members(
      workspace.id,
      { userId: outsideMember.id },
      channel.id,
    );
    expect(outsideView.canAddMembers).toBe(false);
    expect(outsideView.humans.map((human) => human.id).sort()).toEqual(
      [channelMember.id, owner.id].sort(),
    );
    expect(outsideView.agents).toEqual([
      {
        id: memoryId,
        name: "memory",
        displayName: "Memory",
        description: "",
        avatarUrl: agentAvatarUrl(memoryId),
        computerId: null,
        serverRole: "member",
        channelRole: "member",
        channelAdminBasis: undefined,
      },
    ]);
    expect(outsideView.candidates.humans.map((human) => human.id).sort()).toEqual(
      [outsideMember.id, newcomer.id].sort(),
    );
    expect(outsideView.candidates.agents.map((candidate) => candidate.id)).toEqual([agent.id]);

    await expect(
      channels.addMembers(workspace.id, { userId: outsideMember.id }, channel.id, {
        userIds: [newcomer.id],
        agentIds: [],
      }),
    ).rejects.toThrow("ACCESS_DENIED");

    // A channel member with a plain `member` Workspace role may read and add members.
    const memberView = await channels.members(
      workspace.id,
      { userId: channelMember.id },
      channel.id,
    );
    expect(memberView.canAddMembers).toBe(true);

    await expect(
      channels.addMembers(workspace.id, { userId: channelMember.id }, channel.id, {
        userIds: [crypto.randomUUID()],
        agentIds: [],
      }),
    ).rejects.toThrow("INVALID_INPUT");
    await expect(
      channels.addMembers(workspace.id, { userId: channelMember.id }, channel.id, {
        userIds: [],
        agentIds: [crypto.randomUUID()],
      }),
    ).rejects.toThrow("INVALID_INPUT");

    const afterAdd = await channels.addMembers(
      workspace.id,
      { userId: channelMember.id },
      channel.id,
      {
        userIds: [newcomer.id],
        agentIds: [agent.id],
      },
    );
    expect(afterAdd.canAddMembers).toBe(true);
    expect(afterAdd.humans.map((human) => human.id).sort()).toEqual(
      [newcomer.id, owner.id, channelMember.id].sort(),
    );
    expect(afterAdd.agents.map((candidate) => candidate.id).sort()).toEqual(
      [agent.id, memoryId].sort(),
    );
    expect(afterAdd.candidates.humans.map((human) => human.id)).toEqual([outsideMember.id]);
    expect(afterAdd.candidates.agents).toEqual([]);

    // The newly added human is a real conversation member and can send.
    const opened = await channels.open(workspace.id, newcomer.id, channel.id);
    expect(opened.senderMemberId).not.toBe("");

    // The newly added Agent can now be resolved by its target...
    await getAgentChannel(db, workspace.id, agent.id, "#roster");
    // ...and receives an AgentMessageDelivery when a human posts afterward.
    const sent = await channels.send({
      workspaceId: workspace.id,
      userId: owner.id,
      channelId: channel.id,
      idempotencyKey: crypto.randomUUID(),
      body: "Welcome to the roster channel",
    });
    expect(published).toContainEqual(
      expect.objectContaining({ agentId: agent.id, messageId: sent.id }),
    );
    expect(
      await db.agentMessageDelivery.findFirst({
        where: { conversationId: channel.id, agentId: agent.id, messageId: sent.id },
      }),
    ).not.toBeNull();

    // Re-adding an existing member is a no-op (skipDuplicates), not a conflict.
    const reAdded = await channels.addMembers(
      workspace.id,
      { userId: channelMember.id },
      channel.id,
      {
        userIds: [newcomer.id],
        agentIds: [],
      },
    );
    expect(reAdded.humans.map((human) => human.id).sort()).toEqual(
      [newcomer.id, owner.id, channelMember.id].sort(),
    );
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.computer.deleteMany({ where: { ownerId: owner.id } });
    await db.user.deleteMany({
      where: { id: { in: [owner.id, channelMember.id, outsideMember.id, newcomer.id] } },
    });
    await db.$disconnect();
    redis.close();
  }
});

test("channel leave and member removal: owner/admin removes a human and an Agent, a plain member cannot, #general is exempt, and a removed/left member loses send/delivery access until rejoining", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await db.user.create({
    data: { displayName: `lo${suffix}`, username: `lo${suffix}` },
  });
  const admin = await db.user.create({
    data: { displayName: `la${suffix}`, username: `la${suffix}` },
  });
  const plain = await db.user.create({
    data: { displayName: `lp${suffix}`, username: `lp${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `leave-${suffix}`,
      name: "Leave and removal",
      members: {
        create: [
          { userId: owner.id, role: "owner" },
          { userId: admin.id, role: "admin" },
          { userId: plain.id },
        ],
      },
    },
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
        name: `helper${suffix}`,
        displayName: "Helper",
        runtimeConfig: {},
      },
    });
    const general = await enrollGeneral(db, workspace.id);
    const published: ReturnType<typeof decodeAgentMessageDelivery>[] = [];
    const channels = new PublicChannels(
      db,
      new RedisMessageRequestIdempotency(redis),
      withPublishBatch({
        publish: async (_channel, payload) => {
          published.push(decodeAgentMessageDelivery(payload));
        },
        publishJson: async () => {},
        broadcast: async () => {},
      }),
    );

    const ops = await channels.create(workspace.id, owner.id, "ops");
    await channels.join(workspace.id, admin.id, ops.id);
    await channels.join(workspace.id, plain.id, ops.id);
    await channels.addMembers(workspace.id, { userId: owner.id }, ops.id, {
      userIds: [],
      agentIds: [agent.id],
    });

    // Nobody may leave or be removed from #general, regardless of Workspace role.
    await expect(channels.leave(workspace.id, plain.id, general.id)).rejects.toThrow("CONFLICT");
    await expect(
      channels.removeMember(workspace.id, owner.id, general.id, { userId: plain.id }),
    ).rejects.toThrow("CONFLICT");
    const generalMembers = await channels.members(workspace.id, { userId: owner.id }, general.id);
    expect(generalMembers.channelCapabilities.leave).toBe(false);
    expect(generalMembers.canRemoveMembers).toBe(false);

    // A plain member cannot remove anyone.
    await expect(
      channels.removeMember(workspace.id, plain.id, ops.id, { userId: admin.id }),
    ).rejects.toThrow("ACCESS_DENIED");
    const opsMembersAsPlain = await channels.members(workspace.id, { userId: plain.id }, ops.id);
    expect(opsMembersAsPlain.canRemoveMembers).toBe(false);
    expect(opsMembersAsPlain.channelCapabilities.leave).toBe(true);
    const opsMembersAsAdmin = await channels.members(workspace.id, { userId: admin.id }, ops.id);
    expect(opsMembersAsAdmin.canRemoveMembers).toBe(true);

    // `plain` mutes the channel before being removed; the preference and member row must survive.
    await channels.setUserMuted(workspace.id, plain.id, ops.id, true);
    const memberRowBefore = await db.conversationMember.findUniqueOrThrow({
      where: { conversationId_userId: { conversationId: ops.id, userId: plain.id } },
    });
    expect(memberRowBefore.leftAt).toBeNull();
    const plainMessage = await channels.send({
      workspaceId: workspace.id,
      userId: plain.id,
      channelId: ops.id,
      idempotencyKey: crypto.randomUUID(),
      body: "before removal",
    });

    // Owner/admin removes the human: soft-left, message stays, roster excludes them, and they
    // reappear as an add-candidate.
    const removedHuman = await channels.removeMember(workspace.id, admin.id, ops.id, {
      userId: plain.id,
    });
    expect(removedHuman).toEqual({ removed: true, wasMember: true });
    const afterHumanRemoval = await channels.members(workspace.id, { userId: owner.id }, ops.id);
    expect(afterHumanRemoval.humans.map((human) => human.id)).not.toContain(plain.id);
    expect(afterHumanRemoval.candidates.humans.map((human) => human.id)).toContain(plain.id);
    const memberRowAfter = await db.conversationMember.findUniqueOrThrow({
      where: { conversationId_userId: { conversationId: ops.id, userId: plain.id } },
    });
    expect(memberRowAfter.id).toBe(memberRowBefore.id);
    expect(memberRowAfter.leftAt).not.toBeNull();
    expect(memberRowAfter.channelMuted).toBe(true);
    expect(
      await db.message.findUnique({ where: { id: plainMessage.id }, select: { id: true } }),
    ).not.toBeNull();
    // Removing an already-removed member reports wasMember: false.
    const removedAgain = await channels.removeMember(workspace.id, admin.id, ops.id, {
      userId: plain.id,
    });
    expect(removedAgain).toEqual({ removed: true, wasMember: false });

    // A removed/left human can no longer post or follow threads, and the preview reflects it.
    await expect(
      channels.send({
        workspaceId: workspace.id,
        userId: plain.id,
        channelId: ops.id,
        idempotencyKey: crypto.randomUUID(),
        body: "should be denied",
      }),
    ).rejects.toThrow("ACCESS_DENIED");
    await expect(
      channels.setUserThreadFollowed(workspace.id, plain.id, ops.id, plainMessage.id, true),
    ).rejects.toThrow("ACCESS_DENIED");
    const previewAfterRemoval = await channels.open(workspace.id, plain.id, ops.id);
    expect(previewAfterRemoval.senderMemberId).toBe("");
    await expect(channels.leave(workspace.id, plain.id, ops.id)).rejects.toThrow("ACCESS_DENIED");

    // Rejoining (self-service) clears leftAt on the same row and restores send access; the mute
    // preference survived the whole round trip.
    await channels.join(workspace.id, plain.id, ops.id);
    const memberRowRejoined = await db.conversationMember.findUniqueOrThrow({
      where: { conversationId_userId: { conversationId: ops.id, userId: plain.id } },
    });
    expect(memberRowRejoined.id).toBe(memberRowBefore.id);
    expect(memberRowRejoined.leftAt).toBeNull();
    expect(memberRowRejoined.channelMuted).toBe(true);
    const reopened = await channels.open(workspace.id, plain.id, ops.id);
    expect(reopened.senderMemberId).toBe(memberRowBefore.id);
    const resentMessage = await channels.send({
      workspaceId: workspace.id,
      userId: plain.id,
      channelId: ops.id,
      idempotencyKey: crypto.randomUUID(),
      body: "after rejoining",
    });
    expect(resentMessage.senderMemberId).toBe(memberRowBefore.id);

    // Owner/admin removes the Agent: it loses read access to the channel and receives no further
    // deliveries until re-added, at which point `leftAt` clears the same way a human's does.
    const removedAgent = await channels.removeMember(workspace.id, admin.id, ops.id, {
      agentId: agent.id,
    });
    expect(removedAgent).toEqual({ removed: true, wasMember: true });
    await expect(getAgentChannel(db, workspace.id, agent.id, "#ops")).rejects.toThrow(
      "ACCESS_DENIED",
    );
    published.length = 0;
    const afterAgentRemovalSend = await channels.send({
      workspaceId: workspace.id,
      userId: owner.id,
      channelId: ops.id,
      idempotencyKey: crypto.randomUUID(),
      body: "agent should not see this",
    });
    expect(published.some((delivery) => delivery.agentId === agent.id)).toBe(false);
    expect(
      await db.agentMessageDelivery.findFirst({
        where: { conversationId: ops.id, agentId: agent.id, messageId: afterAgentRemovalSend.id },
      }),
    ).toBeNull();

    await channels.addMembers(workspace.id, { userId: owner.id }, ops.id, {
      userIds: [],
      agentIds: [agent.id],
    });
    await getAgentChannel(db, workspace.id, agent.id, "#ops");
    published.length = 0;
    const afterAgentReadd = await channels.send({
      workspaceId: workspace.id,
      userId: owner.id,
      channelId: ops.id,
      idempotencyKey: crypto.randomUUID(),
      body: "agent is back",
    });
    expect(published.some((delivery) => delivery.agentId === agent.id)).toBe(true);
    expect(
      await db.agentMessageDelivery.findFirst({
        where: { conversationId: ops.id, agentId: agent.id, messageId: afterAgentReadd.id },
      }),
    ).not.toBeNull();
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.computer.deleteMany({ where: { ownerId: owner.id } });
    await db.user.deleteMany({ where: { id: { in: [owner.id, admin.id, plain.id] } } });
    await db.$disconnect();
    redis.close();
  }
});
