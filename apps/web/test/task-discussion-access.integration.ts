import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import {
  personConversationAccess,
  readableConversationWhere,
} from "#src/server/conversations/channel-read-access.server";
import { ConversationHistory } from "#src/server/conversations/conversation-history.server";
import { announceJoinedOrLeft } from "#src/server/conversations/channel-membership-signals.server";

import { postTaskNotice } from "#src/server/tasks/task-conversations.server";

const connectionString = Bun.env.TASK_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
if (!connectionString) throw new Error("TASK_TEST_DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const suffix = crypto.randomUUID().slice(0, 8);
let workspaceId = "";
const users = {} as Record<"inside" | "outside" | "stranger", { id: string }>;
const boards = {} as Record<"public" | "private", { id: string; discussionId: string }>;
let insideSeatOnPrivate = "";

beforeAll(async () => {
  const made = await Promise.all(
    (["inside", "outside", "stranger"] as const).map((key) =>
      db.user.create({ data: { username: `tda-${key}-${suffix}`, displayName: key } }),
    ),
  );
  for (const [index, key] of (["inside", "outside", "stranger"] as const).entries())
    users[key] = { id: made[index]!.id };
  const workspace = await db.workspace.create({
    data: {
      slug: `task-disc-access-${suffix}`,
      name: "Task discussion access",
      // `stranger` is in no Workspace at all.
      members: {
        create: [
          { userId: users.inside.id, role: "member" },
          { userId: users.outside.id, role: "member" },
        ],
      },
    },
  });
  workspaceId = workspace.id;
  for (const visibility of ["public", "private"] as const) {
    const board = await db.conversation.create({
      data: {
        workspaceId,
        channelName: `tda-${visibility}-${suffix}`,
        visibility,
        members: { create: [{ userId: users.inside.id }] },
      },
      include: { members: true },
    });
    const task = await db.task.create({
      data: {
        conversationId: board.id,
        workspaceId,
        number: 1,
        title: `a ${visibility} task`,
        creatorMemberId: board.members[0]!.id,
      },
    });
    const notice = await db.$transaction((tx) =>
      postTaskNotice(tx, { conversationId: board.id, workspaceId }, task.id, { body: "hello" }),
    );
    boards[visibility] = { id: board.id, discussionId: notice.conversationId };
  }
  // A seat in the private task's conversation: the person kept it from following the task.
  const seat = await db.conversationMember.create({
    data: {
      workspaceId,
      conversationId: boards.private.discussionId,
      userId: users.outside.id,
    },
  });
  insideSeatOnPrivate = seat.id;
});

afterAll(async () => {
  await db.workspace.delete({ where: { id: workspaceId } });
  await db.user.deleteMany({ where: { id: { in: Object.values(users).map((user) => user.id) } } });
  await db.$disconnect();
});

const history = () => new ConversationHistory(db);
const reads = async (userId: string, conversationId: string) => ({
  history: await history()
    .authorize(workspaceId, userId, conversationId)
    .then(
      () => "read" as const,
      (error: { code?: string }) => error.code,
    ),
  access: await personConversationAccess(db, userId, { id: conversationId, workspaceId }),
  where:
    (await db.conversation.count({
      where: { id: conversationId, ...readableConversationWhere(workspaceId, { userId }) },
    })) === 1,
});

test("a public board's task conversation reads like the channel: any Workspace member", async () => {
  const { discussionId } = boards.public;
  expect(await reads(users.inside.id, discussionId)).toEqual({
    history: "read",
    access: "read",
    where: true,
  });
  expect(await reads(users.outside.id, discussionId)).toEqual({
    history: "read",
    access: "read",
    where: true,
  });
});

test("a person outside the Workspace reads nothing", async () => {
  const result = await reads(users.stranger.id, boards.public.discussionId);
  expect(result.history).toBe("ACCESS_DENIED");
  expect(result.access).toBeUndefined();
  // `readableConversationWhere`, like a channel's, takes Workspace membership as established.
});

test("a private board's task conversation is its members' alone, whatever seat anyone holds", async () => {
  const { discussionId } = boards.private;
  expect((await reads(users.inside.id, discussionId)).history).toBe("read");
  // `outside` holds a seat in the task's conversation but is not on the board.
  expect(await reads(users.outside.id, discussionId)).toEqual({
    history: "NOT_FOUND",
    access: "private",
    where: false,
  });
});

test("leaving the board takes the task conversation with it, though the seat stays", async () => {
  const { discussionId, id } = boards.private;
  await db.conversationMember.updateMany({
    where: { conversationId: id, userId: users.inside.id },
    data: { leftAt: new Date() },
  });
  await db.conversationMember.create({
    data: { workspaceId, conversationId: discussionId, userId: users.inside.id },
  });
  expect(await reads(users.inside.id, discussionId)).toEqual({
    history: "NOT_FOUND",
    access: "private",
    where: false,
  });
  expect(insideSeatOnPrivate).toBeString();
});

test("a hidden board hides its task conversations", async () => {
  await db.conversation.update({
    where: { id: boards.public.id },
    data: { hiddenFromWorkspaceAt: new Date() },
  });
  const result = await reads(users.inside.id, boards.public.discussionId);
  expect(result.access).toBeUndefined();
  expect(result.where).toBe(false);
});

test("leaving a private channel ends the leaver's subscriptions to its task conversations too", async () => {
  const revoked: { userIds: readonly string[]; conversationIds: readonly string[] }[] = [];
  await announceJoinedOrLeft(
    {
      memberChanged: async () => {},
      viewerChanged: async () => {},
      revokeConversations: async (input) => {
        revoked.push(input);
      },
    },
    {
      workspaceId,
      conversationId: boards.private.id,
      change: "left",
      userIds: [users.inside.id],
      private: true,
      db,
    },
  );
  expect(revoked).toHaveLength(1);
  expect([...revoked[0]!.conversationIds].sort()).toEqual(
    [boards.private.id, boards.private.discussionId].sort(),
  );
});

test("a task's conversation is not a board: no task command runs on it", async () => {
  const { TaskBoard } = await import("#src/server/tasks/task-board.server");
  await db.conversationMember.upsert({
    where: {
      conversationId_userId: {
        conversationId: boards.public.discussionId,
        userId: users.inside.id,
      },
    },
    create: {
      workspaceId,
      conversationId: boards.public.discussionId,
      userId: users.inside.id,
    },
    update: { leftAt: null },
  });
  await db.conversation.update({
    where: { id: boards.public.id },
    data: { hiddenFromWorkspaceAt: null },
  });
  await expect(
    new TaskBoard(db, {}).execute(
      { workspaceId, userId: users.inside.id },
      {
        operation: "create",
        idempotencyKey: crypto.randomUUID(),
        conversationId: boards.public.discussionId,
        title: "on a thread",
      },
    ),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});
