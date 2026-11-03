import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { AgentMuteHints } from "#src/server/conversations/agent-mute-hint.server";
import { humanReadState } from "#src/server/conversations/human-unread.server";
import { PublicChannels } from "#src/server/conversations/public-channels.server";

const connectionString = Bun.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const suffix = crypto.randomUUID().slice(0, 8);

let workspaceId: string;
let userId: string;
let agentId: string;
let channelId: string;
let agentMemberId: string;

beforeAll(async () => {
  const user = await db.user.create({
    data: { username: `levels-${suffix}`, displayName: "Levels" },
  });
  userId = user.id;
  const workspace = await db.workspace.create({
    data: {
      slug: `levels-${suffix}`,
      name: "Levels",
      members: { create: { userId, role: "member" } },
    },
  });
  workspaceId = workspace.id;
  const agent = await db.agent.create({
    data: {
      workspaceId,
      ownerId: userId,
      name: `levels-agent-${suffix}`,
      displayName: "Levels Agent",
      runtimeConfig: {},
    },
  });
  agentId = agent.id;
  const channel = await db.conversation.create({
    data: { workspaceId, channelName: `levels-${suffix}`, visibility: "public" },
  });
  channelId = channel.id;
  await db.conversationMember.create({ data: { workspaceId, conversationId: channelId, userId } });
  agentMemberId = (
    await db.conversationMember.create({
      data: { workspaceId, conversationId: channelId, agentId },
    })
  ).id;
});

afterAll(async () => {
  await db.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
  await db.user.delete({ where: { id: userId } }).catch(() => undefined);
  await db.$disconnect();
});

test("none and muted both count unread", async () => {
  const sender = await db.user.create({
    data: { username: `levels-sender-${suffix}`, displayName: "Sender" },
  });
  const senderMember = await db.conversationMember.create({
    data: { workspaceId, conversationId: channelId, userId: sender.id },
  });
  await db.message.create({
    data: {
      workspaceId,
      conversationId: channelId,
      sequence: 1,
      senderMemberId: senderMember.id,
      body: "hi",
    },
  });
  await db.conversationMember.update({
    where: { conversationId_userId: { conversationId: channelId, userId } },
    data: { notificationLevel: "none" },
  });
  expect((await humanReadState(db, channelId, userId)).unreadCount).toBe(1);
  await db.conversationMember.update({
    where: { conversationId_userId: { conversationId: channelId, userId } },
    data: { notificationLevel: "muted" },
  });
  // Muted stops pushing, not counting: the sidebar still shows the unread (as Raft does).
  expect((await humanReadState(db, channelId, userId)).unreadCount).toBe(1);
  await db.user.delete({ where: { id: sender.id } }).catch(() => undefined);
});

test("a noisy channel gets one mute hint, and muting adopts it", async () => {
  const hints = new AgentMuteHints(db);
  for (let index = 0; index < 50; index += 1) {
    const message = await db.message.create({
      data: {
        workspaceId,
        conversationId: channelId,
        sequence: 10 + index,
        senderMemberId: null,
        body: `notice ${index}`,
      },
    });
    await db.agentMessageDelivery.create({
      data: {
        workspaceId,
        conversationId: channelId,
        agentId,
        messageId: message.id,
        sequence: 10 + index,
      },
    });
  }
  const input = {
    workspaceId,
    agentId,
    conversationId: channelId,
    target: "#levels",
    muted: false,
  };
  const first = await hints.forInbox(input);
  expect(first).toContain("coforge channel mute");
  expect(await hints.forInbox(input)).toBeNull();
  await hints.adopt(agentId, channelId);
  const stored = await db.agentMuteHint.findUnique({
    where: { agentId_conversationId: { agentId, conversationId: channelId } },
  });
  expect(stored?.outcome).toBe("adopted");
  expect(agentMemberId).toBeTruthy();
});

test("mentions do not argue for muting: 50 mentioned deliveries make no hint", async () => {
  const channel = await db.conversation.create({
    data: { workspaceId, channelName: `levels-mentions-${suffix}`, visibility: "public" },
  });
  await db.conversationMember.create({
    data: { workspaceId, conversationId: channel.id, agentId },
  });
  for (let index = 0; index < 50; index += 1) {
    const message = await db.message.create({
      data: {
        workspaceId,
        conversationId: channel.id,
        sequence: 100 + index,
        senderMemberId: null,
        body: `mention ${index}`,
      },
    });
    await db.agentMessageDelivery.create({
      data: {
        workspaceId,
        conversationId: channel.id,
        agentId,
        messageId: message.id,
        sequence: 100 + index,
        mentionOutcome: "delivered",
      },
    });
  }
  expect(
    await new AgentMuteHints(db).forInbox({
      workspaceId,
      agentId,
      conversationId: channel.id,
      target: "#mentions",
      muted: false,
    }),
  ).toBeNull();
});

test("the channel list counts unread for a muted member and keeps its mention", async () => {
  const member = await db.conversationMember.findUniqueOrThrow({
    where: { conversationId_userId: { conversationId: channelId, userId } },
  });
  const senderUser = await db.user.create({
    data: { username: `levels-sender2-${suffix}`, displayName: "Sender 2" },
  });
  const sender = await db.conversationMember.create({
    data: { workspaceId, conversationId: channelId, userId: senderUser.id },
  });
  const message = await db.message.create({
    data: {
      workspaceId,
      conversationId: channelId,
      sequence: 500,
      senderMemberId: sender.id,
      body: "@levels please review",
    },
  });
  await db.messageMention.create({
    data: {
      messageId: message.id,
      memberId: member.id,
      conversationId: channelId,
      workspaceId,
      kind: "user",
      actorId: userId,
      handle: `levels-${suffix}`,
    },
  });
  await db.conversationMember.update({
    where: { id: member.id },
    data: { notificationLevel: "muted", channelMuted: true, readThroughSequence: 1 },
  });
  const rows = await new PublicChannels(db, {} as never).list(workspaceId, userId);
  const row = rows.find((channel) => channel.id === channelId);
  expect(row?.muted).toBe(true);
  expect(row?.unreadCount).toBe(1);
  expect(row?.mentioned).toBe(true);
});
