import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { signalNotices } from "#src/server/tasks/task-notice-posting.server";

const connectionString = Bun.env.TASK_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
if (!connectionString) throw new Error("TASK_TEST_DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const suffix = crypto.randomUUID().slice(0, 8);
let workspaceId = "";
let userId = "";
let conversationId = "";
let noticeId = "";

beforeAll(async () => {
  const user = await db.user.create({
    data: { username: `tnact-${suffix}`, displayName: "Reader" },
  });
  userId = user.id;
  const workspace = await db.workspace.create({
    data: {
      slug: `task-notice-activity-${suffix}`,
      name: "Notices",
      members: { create: { userId, role: "member" } },
    },
  });
  workspaceId = workspace.id;
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `tnact-${suffix}`,
      visibility: "private",
      members: { create: { userId } },
    },
  });
  conversationId = channel.id;
  const notice = await db.message.create({
    data: { workspaceId, conversationId, sequence: 1, body: "Task #1 was assigned" },
  });
  noticeId = notice.id;
});

afterAll(async () => {
  await db.workspace.delete({ where: { id: workspaceId } });
  await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});

test("a task notice moves other pages' sidebar rows like any message", async () => {
  const activity: Array<{ userIds: readonly string[]; preview: string }> = [];
  const available: string[] = [];
  const realtime = {
    messageAvailable: async (input: { messageId: string }) => void available.push(input.messageId),
    conversationActivity: async (input: {
      userIds: readonly string[];
      event: { preview: string };
    }) => void activity.push({ userIds: input.userIds, preview: input.event.preview }),
  };
  await signalNotices({ db, dependencies: { realtime } } as never, [
    { id: noticeId, conversationId, sequence: 1 } as never,
  ]);
  expect(available).toEqual([noticeId]);
  expect(activity).toEqual([{ userIds: [userId], preview: "Task #1 was assigned" }]);
});

test("a task's own conversation is hidden: its notice moves no sidebar row", async () => {
  const hidden = await db.conversation.create({
    data: { workspaceId, kind: "task_thread", members: { create: { userId } } },
  });
  const notice = await db.message.create({
    data: { workspaceId, conversationId: hidden.id, sequence: 1, body: "ada stopped following" },
  });
  const activity: unknown[] = [];
  await signalNotices(
    {
      db,
      dependencies: {
        realtime: {
          messageAvailable: async () => {},
          conversationActivity: async (input: unknown) => void activity.push(input),
        },
      },
    } as never,
    [{ id: notice.id, conversationId: hidden.id, sequence: 1 } as never],
  );
  expect(activity).toEqual([]);
});
