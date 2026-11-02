import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { postTaskNotice } from "#src/server/tasks/task-conversations.server";

const connectionString = Bun.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const handle = crypto.randomUUID().slice(0, 8);

let workspaceId: string;
let userId: string;
let conversationId: string;

beforeAll(async () => {
  const user = await db.user.create({
    data: { username: `notice-write-${handle}`, displayName: "Notice Writer" },
  });
  userId = user.id;
  const workspace = await db.workspace.create({
    data: { slug: `notice-write-${handle}`, name: "Notice write" },
  });
  workspaceId = workspace.id;
  const conversation = await db.conversation.create({
    data: { workspaceId, kind: "task_thread" },
  });
  conversationId = conversation.id;
  await db.conversationMember.create({
    data: { workspaceId, conversationId, userId },
  });
});

afterAll(async () => {
  await db.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
  await db.user.delete({ where: { id: userId } }).catch(() => undefined);
  await db.$disconnect();
});

test("a task notice writes its structured SystemMessage row with the message", async () => {
  const task = await db.task.create({
    data: {
      workspaceId,
      conversationId,
      number: 1,
      title: "A notice",
      creatorMemberId: (
        await db.conversationMember.findFirstOrThrow({
          where: { conversationId, userId },
          select: { id: true },
        })
      ).id,
    },
  });
  const system = {
    kind: "task.assigned_you" as const,
    params: {
      actor: { memberId: null, handle: "ada", displayName: "Ada" },
      task: { taskId: task.id, number: 1, title: "A notice" },
    },
  };
  const posted = await db.$transaction((tx) =>
    postTaskNotice(tx, { workspaceId, conversationId }, task.id, {
      body: "ada assigned you task #1: A notice",
      system,
    }),
  );
  const stored = await db.systemMessage.findUnique({ where: { messageId: posted.id } });
  expect(stored).toMatchObject({ kind: system.kind, params: system.params });
  expect(stored?.workspaceId).toBe(workspaceId);
});
