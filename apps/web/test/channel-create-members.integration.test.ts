import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import {
  PublicChannels,
  enrollGeneralChannel,
} from "#src/server/conversations/public-channels.server";
import type { ConversationRealtime } from "#src/server/conversations/conversation-realtime.server";

/**
 * Creating a channel with the people and Agents picked for it: the channel exists with its
 * creator as admin, the picked members are added through `addMembers` (its Agent visibility and
 * membership rules), and a refused add leaves the channel in place. Drives the real
 * `PublicChannels` against local PostgreSQL.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

async function setup() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString! }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const creator = await db.user.create({ data: { username: `ccm-creator-${suffix}` } });
  const ada = await db.user.create({ data: { username: `ccm-ada-${suffix}` } });
  const bob = await db.user.create({ data: { username: `ccm-bob-${suffix}` } });
  const otherOwner = await db.user.create({ data: { username: `ccm-owner-${suffix}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `ccm-${suffix}`,
      name: "Create with members",
      members: {
        create: [
          { userId: creator.id, role: "member" },
          { userId: ada.id, role: "member" },
          { userId: bob.id, role: "member" },
          { userId: otherOwner.id, role: "member" },
        ],
      },
    },
  });
  await enrollGeneralChannel(db, workspace.id);
  const createAgent = (name: string, ownerId: string, visibility: "public" | "private") =>
    db.agent.create({
      data: {
        workspaceId: workspace.id,
        name: `${name}-${suffix}`,
        displayName: name,
        ownerId,
        visibility,
        runtimeConfig: {
          runtime: "pi",
          provider: { kind: "default" },
          model: "",
          modelProvider: "",
          reasoning: "",
        },
      },
    });
  const publicAgent = await createAgent("atlas", creator.id, "public");
  const privateAgent = await createAgent("secret", otherOwner.id, "private");
  // Announcements are not under test here: a no-op port keeps the run quiet.
  const realtime: ConversationRealtime = {
    async messageAvailable() {},
    async memberChanged() {},
    async channelUpdated() {},
    async channelCreated() {},
    async viewerChanged() {},
  };
  const channels = new PublicChannels(db, undefined, undefined, undefined, realtime);
  return {
    db,
    channels,
    workspace,
    creator,
    ada,
    bob,
    publicAgent,
    privateAgent,
    suffix,
  };
}

async function teardown(db: PrismaClient, workspaceId: string, userIds: string[]) {
  await db.workspace.delete({ where: { id: workspaceId } }).catch(() => {});
  await db.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  await db.$disconnect();
}

async function activeMembers(db: PrismaClient, conversationId: string) {
  const rows = await db.conversationMember.findMany({
    where: { conversationId, leftAt: null },
    select: { userId: true, agentId: true, channelRole: true },
  });
  return {
    userIds: rows.flatMap((row) => (row.userId ? [row.userId] : [])).sort(),
    agentIds: rows.flatMap((row) => (row.agentId ? [row.agentId] : [])).sort(),
    adminUserIds: rows
      .filter((row) => row.channelRole === "admin")
      .flatMap((row) => (row.userId ? [row.userId] : [])),
  };
}

test.skipIf(!connectionString)(
  "a channel created with two people and a public Agent lists them as members beside the creator",
  async () => {
    const { db, channels, workspace, creator, ada, bob, publicAgent } = await setup();
    try {
      const created = await channels.createWithMembers(workspace.id, creator.id, {
        name: "crew",
        userIds: [ada.id, bob.id],
        agentIds: [publicAgent.id],
      });
      expect(created.membersAddFailed).toBeFalse();
      const members = await activeMembers(db, created.id);
      expect(members.userIds).toEqual([ada.id, bob.id, creator.id].sort());
      expect(members.agentIds).toEqual([publicAgent.id]);
      // The creator stays the channel's admin; the picked members are plain members.
      expect(members.adminUserIds).toEqual([creator.id]);
    } finally {
      await teardown(db, workspace.id, [creator.id, ada.id, bob.id]);
    }
  },
);

test.skipIf(!connectionString)(
  "a private Agent of someone else is refused by the add, and the channel is still created",
  async () => {
    const { db, channels, workspace, creator, ada, privateAgent } = await setup();
    try {
      const created = await channels.createWithMembers(workspace.id, creator.id, {
        name: "private-pick",
        userIds: [ada.id],
        agentIds: [privateAgent.id],
      });
      expect(created.membersAddFailed).toBeTrue();
      // The whole add is refused: the channel exists with only its creator in it.
      const channel = await db.conversation.findUniqueOrThrow({ where: { id: created.id } });
      expect(channel.channelName).toBe("private-pick");
      const members = await activeMembers(db, created.id);
      expect(members.userIds).toEqual([creator.id]);
      expect(members.agentIds).toEqual([]);
    } finally {
      await teardown(db, workspace.id, [creator.id, ada.id]);
    }
  },
);

test.skipIf(!connectionString)(
  "a channel created with an unknown person picked is created with only its creator",
  async () => {
    const { db, channels, workspace, creator, ada } = await setup();
    try {
      const created = await channels.createWithMembers(workspace.id, creator.id, {
        name: "bad-user",
        userIds: [ada.id, crypto.randomUUID()],
        agentIds: [],
      });
      // The whole add is refused on the first unknown id: the channel stays, nobody is added.
      expect(created.membersAddFailed).toBeTrue();
      const members = await activeMembers(db, created.id);
      expect(members.userIds).toEqual([creator.id]);
    } finally {
      await teardown(db, workspace.id, [creator.id, ada.id]);
    }
  },
);

test.skipIf(!connectionString)(
  "a private Agent the creator owns is refused by the add, and the channel is still created",
  async () => {
    const { db, channels, workspace, creator, ada } = await setup();
    try {
      const ownPrivate = await db.agent.create({
        data: {
          workspaceId: workspace.id,
          name: `mine-${crypto.randomUUID().slice(0, 8)}`,
          displayName: "Mine",
          ownerId: creator.id,
          visibility: "private",
          runtimeConfig: {
            runtime: "pi",
            provider: { kind: "default" },
            model: "",
            modelProvider: "",
            reasoning: "",
          },
        },
      });
      const created = await channels.createWithMembers(workspace.id, creator.id, {
        name: "own-private",
        userIds: [ada.id],
        agentIds: [ownPrivate.id],
      });
      expect(created.membersAddFailed).toBeTrue();
      const members = await activeMembers(db, created.id);
      expect(members.userIds).toEqual([creator.id]);
      expect(members.agentIds).toEqual([]);
    } finally {
      await teardown(db, workspace.id, [creator.id, ada.id]);
    }
  },
);

test.skipIf(!connectionString)(
  "a channel created with no one picked is created as before, with only its creator",
  async () => {
    const { db, channels, workspace, creator } = await setup();
    try {
      const created = await channels.createWithMembers(workspace.id, creator.id, {
        name: "solo",
        userIds: [],
        agentIds: [],
      });
      expect(created.membersAddFailed).toBeFalse();
      const members = await activeMembers(db, created.id);
      expect(members.userIds).toEqual([creator.id]);
      expect(members.agentIds).toEqual([]);
    } finally {
      await teardown(db, workspace.id, [creator.id]);
    }
  },
);
