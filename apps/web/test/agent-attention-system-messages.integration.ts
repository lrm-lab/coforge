import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { agentAttentionIdsSql } from "#src/server/db/repositories/agent-attention.repositories.server";

const connectionString = Bun.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const suffix = crypto.randomUUID().slice(0, 8);

let workspaceId: string;
let userId: string;
let agentId: string;
let conversationId: string;

beforeAll(async () => {
  const user = await db.user.create({
    data: { username: `attention-${suffix}`, displayName: "Attention" },
  });
  userId = user.id;
  const workspace = await db.workspace.create({
    data: {
      slug: `attention-${suffix}`,
      name: "Attention",
      members: { create: { userId, role: "member" } },
    },
  });
  workspaceId = workspace.id;
  const agent = await db.agent.create({
    data: {
      workspaceId,
      ownerId: userId,
      name: `attention-agent-${suffix}`,
      displayName: "Attention Agent",
      runtimeConfig: {},
    },
  });
  agentId = agent.id;
  const conversation = await db.conversation.create({
    data: { workspaceId, channelName: `attention-${suffix}`, visibility: "public" },
  });
  conversationId = conversation.id;
});

afterAll(async () => {
  await db.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
  await db.user.delete({ where: { id: userId } }).catch(() => undefined);
  await db.$disconnect();
});

test("a delivered system notice is not attention; a human message is", async () => {
  const member = await db.conversationMember.create({
    data: { workspaceId, conversationId, userId },
  });
  const human = await db.message.create({
    data: { workspaceId, conversationId, sequence: 1, senderMemberId: member.id, body: "hi" },
  });
  const system = await db.message.create({
    data: { workspaceId, conversationId, sequence: 2, senderMemberId: null, body: "📋 1 new task" },
  });
  await db.agentMessageDelivery.createMany({
    data: [
      { workspaceId, conversationId, agentId, messageId: human.id, sequence: 1 },
      { workspaceId, conversationId, agentId, messageId: system.id, sequence: 2 },
    ],
  });
  const rows = await db.$queryRaw<{ id: string }[]>(
    agentAttentionIdsSql({ agentId, conversationId, threadRootId: null, isChannel: true }, 10),
  );
  expect(rows.map((row) => row.id)).toEqual([human.id]);
});
