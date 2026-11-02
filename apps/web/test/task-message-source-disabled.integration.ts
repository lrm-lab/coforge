import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import {
  TASK_MESSAGE_SOURCE_REQUIRES_CONVERSATIONS,
  TaskBoard,
} from "#src/server/tasks/task-board.server";

const connectionString = Bun.env.TASK_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
if (!connectionString) throw new Error("TASK_TEST_DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const suffix = crypto.randomUUID().slice(0, 8);

let workspaceId: string;
let userId: string;
let conversationId: string;
let messageId: string;

beforeAll(async () => {
  const user = await db.user.create({
    data: { username: `msg-source-${suffix}`, displayName: "Message Source" },
  });
  userId = user.id;
  const workspace = await db.workspace.create({
    data: {
      slug: `msg-source-${suffix}`,
      name: "Message source",
      members: { create: { userId, role: "member" } },
    },
  });
  workspaceId = workspace.id;
  const conversation = await db.conversation.create({
    data: { workspaceId, channelName: `msg-source-${suffix}`, visibility: "public" },
  });
  conversationId = conversation.id;
  const member = await db.conversationMember.create({
    data: { workspaceId, conversationId, userId },
  });
  const message = await db.message.create({
    data: {
      workspaceId,
      conversationId,
      sequence: 1,
      senderMemberId: member.id,
      body: "a message to make a task from",
    },
  });
  messageId = message.id;
});

afterAll(async () => {
  await db.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
  await db.user.delete({ where: { id: userId } }).catch(() => undefined);
  await db.$disconnect();
});

test("create --message-id with task conversations off names the reason and the next step", async () => {
  await expect(
    new TaskBoard(db, {}).execute(
      { workspaceId, userId },
      {
        operation: "create",
        idempotencyKey: crypto.randomUUID(),
        conversationId,
        messageId,
        title: "From a message",
      },
    ),
  ).rejects.toMatchObject({
    code: "INVALID_INPUT",
    errorId: TASK_MESSAGE_SOURCE_REQUIRES_CONVERSATIONS,
  });
});
