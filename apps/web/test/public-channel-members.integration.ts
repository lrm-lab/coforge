import { expect, test } from "bun:test";
import { defaultMemoryAgentId } from "./helpers/default-memory-agent-fixture";
import { agentAvatarUrl } from "#src/features/agents/agent-mascot";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PublicChannels, getAgentChannel } from "#src/server/conversations/public-channels.server";
import { enrollGeneralChannel } from "#src/server/conversations/general-channel.server";
import { RedisClient } from "bun";
import { RedisMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import { decodeAgentMessageDelivery } from "@lrm/coforge-sdk/internal";

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
    const channels = new PublicChannels(db, new RedisMessageRequestIdempotency(redis), {
      publish: async (_channel, payload) => {
        published.push(decodeAgentMessageDelivery(payload));
      },
      publishJson: async () => {},
      broadcast: async () => {},
    });

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
