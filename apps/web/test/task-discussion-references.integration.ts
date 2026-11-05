import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { postTaskMessage } from "#src/server/tasks/task-discussion-send.server";

const connectionString = Bun.env.TASK_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
if (!connectionString) throw new Error("TASK_TEST_DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const suffix = crypto.randomUUID().slice(0, 8);
let workspaceId = "";
let channelId = "";
let member: { id: string; userId: string | null; agentId: string | null };

afterAll(() => db.$disconnect());
beforeAll(async () => {
  const user = await db.user.create({
    data: { username: `tdref-${suffix}`, displayName: "Ref Writer" },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `tdref-${suffix}`,
      name: "Task discussion references",
      members: { create: { userId: user.id, role: "member" } },
    },
  });
  workspaceId = workspace.id;
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `tdref-${suffix}`,
      members: { create: [{ userId: user.id }] },
    },
    include: { members: true },
  });
  channelId = channel.id;
  const seat = channel.members[0]!;
  member = { id: seat.id, userId: seat.userId, agentId: seat.agentId };
});

// task #558: a reply in a task's own conversation that names another task (`#N`) writes its
// reference row under the reply's conversation, the task discussion, not the board's channel;
// the mismatch broke message_references' (messageId, conversationId) foreign key and the send.
test("a task discussion reply naming a task writes its reference in the discussion", async () => {
  const task = (number: number) =>
    db.task.create({
      data: {
        conversationId: channelId,
        workspaceId,
        number,
        title: `task ${number}`,
        creatorMemberId: member.id,
        ownerMemberId: member.id,
        status: "todo",
      },
    });
  const [discussed, named] = [await task(1), await task(2)];

  const posted = await db.$transaction((tx) =>
    postTaskMessage(tx, {
      taskId: discussed.id,
      scope: { conversationId: channelId, workspaceId },
      member,
      body: "see #2 before this one",
    }),
  );

  const message = await db.message.findUniqueOrThrow({
    where: { id: posted.messageId },
    select: { conversationId: true },
  });
  const { discussionConversationId } = await db.task.findUniqueOrThrow({
    where: { id: discussed.id },
    select: { discussionConversationId: true },
  });
  expect(message.conversationId).toBe(discussionConversationId!);
  expect(message.conversationId).not.toBe(channelId);
  const references = await db.messageReference.findMany({ where: { messageId: posted.messageId } });
  expect(references.map((row) => [row.kind, row.targetId, row.conversationId])).toEqual([
    ["task", named.id, discussionConversationId!],
  ]);
});
