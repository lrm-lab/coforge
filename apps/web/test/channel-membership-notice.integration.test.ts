import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import {
  joinChannel,
  leaveChannel,
  removeChannelMember,
} from "#src/server/conversations/channel-roster.server";
import { upsertChannelMembers } from "#src/server/conversations/channel-changes.server";
import { joinChannelAsAgent } from "#src/server/conversations/agent-channel-join.server";
import { softLeaveMember } from "#src/server/conversations/channel-changes.server";
import { humanReadState } from "#src/server/conversations/human-unread.server";
import { joinGeneralChannel } from "#src/server/conversations/general-channel.server";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { PrismaWorkspaceMemberDirectoryStore } from "#src/server/workspaces/member-directory-store.server";
import { PrismaAgentDeletionStore } from "#src/server/db/repositories/agent-deletion.repositories.server";

const connectionString = Bun.env.DATABASE_URL;
const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: connectionString! }),
});
const suffix = crypto.randomUUID().slice(0, 8);

let workspaceId: string;
let ownerId: string;
let aliceId: string;
let agentId: string;
let channelId: string;

beforeAll(async () => {
  if (!connectionString) return;
  const owner = await db.user.create({
    data: { username: `mem-own-${suffix}`, displayName: "Owner" },
  });
  const alice = await db.user.create({
    data: { username: `mem-alice-${suffix}`, displayName: "Alice" },
  });
  ownerId = owner.id;
  aliceId = alice.id;
  const workspace = await db.workspace.create({
    data: {
      slug: `mem-${suffix}`,
      name: "Mem",
      members: {
        create: [
          { userId: ownerId, role: "owner" },
          { userId: aliceId, role: "member" },
        ],
      },
    },
  });
  workspaceId = workspace.id;
  const computer = await db.computer.create({
    data: { ownerId, machineId: `mem-machine-${suffix}` },
  });
  const agent = await db.agent.create({
    data: {
      workspaceId,
      ownerId,
      name: `mem-agent-${suffix}`,
      displayName: "Mem Agent",
      runtimeConfig: {},
      computerId: computer.id,
    },
  });
  agentId = agent.id;
  const channel = await db.conversation.create({
    data: { workspaceId, channelName: `mem-${suffix}`, visibility: "public" },
  });
  channelId = channel.id;
  await db.conversationMember.create({
    data: { workspaceId, conversationId: channelId, userId: ownerId },
  });
});

afterAll(async () => {
  if (!connectionString) return;
  await db.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
  await db.user.delete({ where: { id: ownerId } }).catch(() => undefined);
  await db.user.delete({ where: { id: aliceId } }).catch(() => undefined);
  await db.$disconnect();
});

const notices = async (kind: string) =>
  db.systemMessage.findMany({
    where: { conversationId: channelId, kind },
    orderBy: { createdAt: "asc" },
    select: { kind: true, params: true },
  });

const ports = {
  db,
  inboxPurge: { purge: async () => {} },
} as never;

test.skipIf(!connectionString)(
  "a person joining posts a member_joined record, no delivery and no unread",
  async () => {
    await joinChannel(ports, workspaceId, aliceId, channelId);
    const rows = await notices("channel.member_joined");
    expect(rows).toHaveLength(1);
    const params = rows[0]!.params as { members: { memberId: string; handle: string }[] };
    expect(params.members).toHaveLength(1);
    expect(params.members[0]!.handle).toBe(`mem-alice-${suffix}`);
    const message = await db.message.findFirstOrThrow({
      where: { conversationId: channelId, systemMessage: { isNot: null } },
      select: { senderMemberId: true, deliveries: true },
    });
    expect(message.senderMemberId).toBeNull();
    expect(message.deliveries).toHaveLength(0);
  },
);

test.skipIf(!connectionString)(
  "adding people posts one member_added record naming the actor and all members",
  async () => {
    const bob = await db.user.create({
      data: { username: `mem-bob-${suffix}`, displayName: "Bob" },
    });
    await db.workspaceMembership.create({
      data: { workspaceId, userId: bob.id, role: "member" },
    });
    const channelId2 = (
      await db.conversation.create({
        data: { workspaceId, channelName: `mem2-${suffix}`, visibility: "public" },
      })
    ).id;
    await db.conversationMember.createMany({
      data: [
        { workspaceId, conversationId: channelId2, userId: ownerId },
        { workspaceId, conversationId: channelId2, userId: aliceId },
      ],
    });
    await upsertChannelMembers(
      db as never,
      { workspaceId, channelId: channelId2, readThroughSequence: 0 },
      {
        userIds: [bob.id],
        agentIds: [agentId],
        alreadyMemberUserIds: [],
        alreadyMemberAgentIds: [],
        actor: { userId: ownerId },
      },
    );
    const rows = await db.systemMessage.findMany({
      where: { conversationId: channelId2, kind: "channel.member_added" },
      select: { params: true },
    });
    expect(rows).toHaveLength(1);
    const params = rows[0]!.params as {
      members: { handle: string; kind: string }[];
      actor: { handle: string };
    };
    expect(params.actor.handle).toBe(`mem-own-${suffix}`);
    const ids = new Set(params.members.map((m) => m.handle));
    expect(ids).toEqual(new Set([`mem-bob-${suffix}`, `mem-agent-${suffix}`]));
    await db.user.delete({ where: { id: bob.id } }).catch(() => undefined);
  },
);

test.skipIf(!connectionString)(
  "leaving posts member_left; removal posts member_removed naming the actor",
  async () => {
    await leaveChannel(ports, workspaceId, aliceId, channelId);
    const left = await notices("channel.member_left");
    expect(left).toHaveLength(1);
    await joinChannel(ports, workspaceId, aliceId, channelId);
    const removed = await removeChannelMember(ports, workspaceId, ownerId, channelId, {
      userId: aliceId,
    });
    expect(removed.wasMember).toBe(true);
    const rows = await notices("channel.member_removed");
    expect(rows).toHaveLength(1);
    const params = rows[0]!.params as {
      members: { handle: string }[];
      actor: { handle: string };
    };
    expect(params.actor.handle).toBe(`mem-own-${suffix}`);
    expect(params.members[0]!.handle).toBe(`mem-alice-${suffix}`);
  },
);

test.skipIf(!connectionString)(
  "the record never counts unread: its Message has no sender member row",
  async () => {
    const state = await humanReadState(db, channelId, ownerId);
    expect(state.unreadCount).toBe(0);
  },
);

test.skipIf(!connectionString)(
  "an Agent joining and leaving posts member_joined and member_left records",
  async () => {
    const { joined, notice } = await joinChannelAsAgent(db, workspaceId, channelId, agentId);
    expect(joined).toBe(true);
    expect(notice).not.toBeNull();
    const joined2 = await joinChannelAsAgent(db, workspaceId, channelId, agentId);
    expect(joined2.joined).toBe(false);
    expect(joined2.notice).toBeNull();
    const rows = await notices("channel.member_joined");
    const agentRows = rows.filter(
      (row) => (row.params as { members: { kind: string }[] }).members[0]!.kind === "agent",
    );
    expect(agentRows).toHaveLength(1);
    const params = agentRows[0]!.params as { members: { handle: string }[] };
    expect(params.members[0]!.handle).toBe(`mem-agent-${suffix}`);

    const { wasMember } = await softLeaveMember(db, workspaceId, channelId, { agentId });
    expect(wasMember).toBe(true);
    const left = await notices("channel.member_left");
    const agentLeft = left.filter(
      (row) => (row.params as { members: { kind: string }[] }).members[0]!.kind === "agent",
    );
    expect(agentLeft).toHaveLength(1);
  },
);

test.skipIf(!connectionString)(
  "removing an Agent posts member_removed naming the person who removed it",
  async () => {
    await joinChannelAsAgent(db, workspaceId, channelId, agentId);
    const removed = await removeChannelMember(ports, workspaceId, ownerId, channelId, {
      agentId,
    });
    expect(removed.wasMember).toBe(true);
    const rows = await notices("channel.member_removed");
    const agentRows = rows.filter(
      (row) => (row.params as { members: { kind: string }[] }).members[0]!.kind === "agent",
    );
    expect(agentRows).toHaveLength(1);
    const params = agentRows[0]!.params as {
      members: { handle: string }[];
      actor: { handle: string };
    };
    expect(params.actor.handle).toBe(`mem-own-${suffix}`);
    expect(params.members[0]!.handle).toBe(`mem-agent-${suffix}`);
  },
);

test.skipIf(!connectionString)(
  "a Workspace member removal records member_removed, and the operator is named even in a channel they never joined",
  async () => {
    // The owner is not a member of this channel; the record still shows their name, not a user id.
    const other = await db.conversation.create({
      data: { workspaceId, channelName: `mem3-${suffix}`, visibility: "public" },
    });
    await db.conversationMember.createMany({
      data: [
        { workspaceId, conversationId: other.id, userId: aliceId },
        { workspaceId, conversationId: other.id, agentId },
      ],
    });
    const store = new PrismaWorkspaceMemberDirectoryStore(db);
    const removed = await store.removeMember(workspaceId, aliceId, {
      operator: { userId: ownerId },
    });
    expect(removed.leftChannelIds).toContain(other.id);
    const rows = await db.systemMessage.findMany({
      where: { conversationId: other.id, kind: "channel.member_removed" },
      select: { params: true },
    });
    // One record for the person the removal was about, named by the owner — a member of the
    // channel never joined by them, resolved from their User row, not a raw id.
    expect(rows).toHaveLength(1);
    const params = rows[0]!.params as { actor: { handle: string; displayName: string } };
    expect(params.actor.handle).toBe(`mem-own-${suffix}`);
    expect(params.actor.displayName).toBe("Owner");
  },
);

test.skipIf(!connectionString)(
  "deleting an Agent records member_removed naming the deleter",
  async () => {
    const agent2 = await db.agent.create({
      data: {
        workspaceId,
        ownerId,
        name: `mem-gone-${suffix}`,
        displayName: "Gone Agent",
        runtimeConfig: {},
        computerId: (await db.agent.findUniqueOrThrow({ where: { id: agentId } })).computerId,
      },
    });
    await db.conversationMember.create({
      data: { workspaceId, conversationId: channelId, agentId: agent2.id },
    });
    const store = new PrismaAgentDeletionStore(db);
    await store.delete({
      agentId: agent2.id,
      workspaceId,
      deletedAt: new Date(),
      deletedByUserId: ownerId,
    });
    const rows = await notices("channel.member_removed");
    const gone = rows.filter((row) =>
      (row.params as { members: { handle: string }[] }).members.some(
        (member) => member.handle === `mem-gone-${suffix}`,
      ),
    );
    expect(gone).toHaveLength(1);
    const params = gone[0]!.params as { actor: { handle: string } };
    expect(params.actor.handle).toBe(`mem-own-${suffix}`);
  },
);

test.skipIf(!connectionString)(
  "#general enrollment and a direct conversation write no membership records",
  async () => {
    const generalId = await db.$transaction((tx) => joinGeneralChannel(tx, workspaceId, agentId));
    expect(
      await db.systemMessage.count({
        where: { conversationId: generalId, kind: { startsWith: "channel.member_" } },
      }),
    ).toBe(0);

    const dm = await db.conversation.create({
      data: { workspaceId, directKey: `dm:${ownerId}:${aliceId}` },
    });
    await db.conversationMember.createMany({
      data: [
        { workspaceId, conversationId: dm.id, userId: ownerId },
        { workspaceId, conversationId: dm.id, userId: aliceId },
      ],
    });
    expect(
      await db.systemMessage.count({
        where: { conversationId: dm.id, kind: { startsWith: "channel.member_" } },
      }),
    ).toBe(0);
  },
);

test.skipIf(!connectionString)(
  "creating a channel with initial members writes no member_added record",
  async () => {
    const carol = await db.user.create({
      data: { username: `mem-carol-${suffix}`, displayName: "Carol" },
    });
    await db.workspaceMembership.create({
      data: { workspaceId, userId: carol.id, role: "member" },
    });
    const channels = new PublicChannels(db);
    const { id, membersAddFailed } = await channels.createWithMembers(workspaceId, ownerId, {
      name: `mem4-${suffix}`,
      userIds: [carol.id],
      agentIds: [agentId],
    });
    expect(membersAddFailed).toBe(false);
    expect(
      await db.systemMessage.count({
        where: { conversationId: id, kind: { startsWith: "channel.member_" } },
      }),
    ).toBe(0);
  },
);
