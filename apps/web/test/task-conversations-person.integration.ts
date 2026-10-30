import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PrismaExperimentsRepository } from "#src/server/experiments/experiments.repositories.server";
import { readFeatureFlagsConfiguration } from "#src/server/feature-flags/configuration.server";
import { installFeatureFlags } from "#src/server/feature-flags/feature-flags.server";
import {
  announceSpawnedTask,
  sentMessageSpawnsTask,
} from "#src/server/tasks/sent-as-conversation-task.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";

const connectionString = Bun.env.TASK_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
if (!connectionString) throw new Error("TASK_TEST_DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const suffix = crypto.randomUUID().slice(0, 8);
let directory = "";
let workspaceId = "";
let channelId = "";
let sourceId = "";
const people = {} as Record<"actor" | "author", { id: string; memberId: string }>;
const board = new TaskBoard(db, {});
const run = (command: Record<string, unknown>) =>
  board.execute({ workspaceId, userId: people.actor.id }, {
    idempotencyKey: crypto.randomUUID(),
    conversationId: channelId,
    ...command,
  } as Parameters<TaskBoard["execute"]>[1]);
const experiment = (enabled: boolean) =>
  new PrismaExperimentsRepository(db).write(workspaceId, "taskConversations", enabled);

beforeAll(async () => {
  const users = await Promise.all(
    (["actor", "author"] as const).map((key) =>
      db.user.create({ data: { username: `tcp-${key}-${suffix}`, displayName: key } }),
    ),
  );
  const workspace = await db.workspace.create({
    data: {
      slug: `task-conv-person-${suffix}`,
      name: "Task conversations, people",
      members: { create: users.map((user) => ({ userId: user.id, role: "owner" })) },
    },
  });
  workspaceId = workspace.id;
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `tcp-${suffix}`,
      members: { create: users.map((user) => ({ userId: user.id })) },
    },
    include: { members: true },
  });
  channelId = channel.id;
  for (const [index, key] of (["actor", "author"] as const).entries())
    people[key] = {
      id: users[index]!.id,
      memberId: channel.members.find((member) => member.userId === users[index]!.id)!.id,
    };
  const source = await db.message.create({
    data: {
      conversationId: channelId,
      workspaceId,
      senderMemberId: people.author.memberId,
      body: "please fix the login page",
      sequence: 1,
    },
  });
  sourceId = source.id;
  await db.conversation.update({ where: { id: channelId }, data: { lastSequence: 100 } });
  directory = await mkdtemp(join(tmpdir(), "coforge-task-conv-person-"));
  const path = join(directory, "flags.json");
  await writeFile(
    path,
    JSON.stringify({
      $schema: "https://flagd.dev/schema/v0/flags.json",
      flags: {
        "task-conversations": {
          state: "ENABLED",
          variants: { on: true, off: false },
          defaultVariant: "on",
        },
      },
    }),
  );
  await installFeatureFlags(
    await readFeatureFlagsConfiguration({ COFORGE_FEATURE_FLAGS_FILE: path }),
  );
  await experiment(true);
});

afterAll(async () => {
  await installFeatureFlags({ status: "disabled" });
  await rm(directory, { recursive: true, force: true });
  await db.workspace.delete({ where: { id: workspaceId } });
  await db.user.deleteMany({ where: { id: { in: Object.values(people).map((p) => p.id) } } });
  await db.$disconnect();
});

const messageCount = () => db.message.count({ where: { conversationId: channelId } });

test("a person's new task has no message in the channel and is followed by them", async () => {
  const before = await messageCount();
  const { tasks } = await run({ operation: "create", title: "Write the docs" });
  expect(await messageCount()).toBe(before);
  const task = tasks[0]!;
  expect(task.messageId).not.toBe(sourceId);
  expect(task.sourceMessageId).toBeUndefined();
  expect(
    await db.taskFollow.count({
      where: { taskId: task.id, memberId: people.actor.memberId },
    }),
  ).toBe(1);
});

test("converting someone's message makes a task beside it and tells its author in the thread", async () => {
  const before = await messageCount();
  const { tasks } = await run({ operation: "convert", messageId: sourceId });
  const task = tasks[0]!;
  expect(task).toMatchObject({ title: "please fix the login page", sourceMessageId: sourceId });
  expect(task.messageId).not.toBe(sourceId);
  // The message is not the task; the only new message is the notice in its thread.
  expect(await db.task.findUnique({ where: { messageId: sourceId } })).toBeNull();
  expect(await messageCount()).toBe(before + 1);
  const notice = await db.message.findFirstOrThrow({
    where: { conversationId: channelId, threadRootId: sourceId },
  });
  expect(notice.senderMemberId).toBeNull();
  expect(notice.body).toContain(`#${task.number}`);
});

test("a message someone else is working on is taken, unless the person says alongside", async () => {
  const held = await db.task.findFirstOrThrow({ where: { sourceMessageId: sourceId } });
  await db.task.update({
    where: { id: held.id },
    data: { ownerMemberId: people.author.memberId, status: "in_progress" },
  });
  await expect(run({ operation: "convert", messageId: sourceId })).rejects.toMatchObject({
    code: "CONFLICT",
    errorId: "source_message_taken",
  });
  const beside = await run({ operation: "convert", messageId: sourceId, alongside: true });
  expect(beside.tasks[0]!.sourceMessageId).toBe(sourceId);
});

test("with the experiment off a message is turned into the task itself, as before", async () => {
  await experiment(false);
  try {
    await expect(
      run({ operation: "convert", messageId: sourceId, alongside: true }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  } finally {
    await experiment(true);
  }
});

test("send as task spawns a task from the sent message without a notice", async () => {
  const sent = await db.message.create({
    data: {
      conversationId: channelId,
      workspaceId,
      senderMemberId: people.actor.memberId,
      body: "ship it",
      sequence: 20,
    },
  });
  await db.$transaction((tx) =>
    sentMessageSpawnsTask(tx, {
      id: sent.id,
      conversationId: channelId,
      workspaceId,
      body: sent.body,
      senderMemberId: people.actor.memberId,
      threadRootId: null,
    }),
  );
  const task = await db.task.findFirstOrThrow({ where: { sourceMessageId: sent.id } });
  expect(task).toMatchObject({ title: "ship it", messageId: null });
  expect(await db.message.count({ where: { threadRootId: sent.id } })).toBe(0);
  expect(
    await announceSpawnedTask(
      { db, reader: "people", dependencies: {} },
      {
        conversationId: channelId,
        workspaceId,
      },
      sent.id,
    ),
  ).toBe(true);
  expect(
    await announceSpawnedTask(
      { db, reader: "people", dependencies: {} },
      {
        conversationId: channelId,
        workspaceId,
      },
      sourceId,
    ),
  ).toBe(false);
});

test("a task shows its conversation and the thread it had before", async () => {
  const host = await db.message.create({
    data: {
      conversationId: channelId,
      workspaceId,
      senderMemberId: people.author.memberId,
      body: "an older task",
      sequence: 30,
    },
  });
  await db.message.create({
    data: {
      conversationId: channelId,
      workspaceId,
      threadRootId: host.id,
      senderMemberId: people.actor.memberId,
      body: "a reply",
      sequence: 31,
    },
  });
  await db.task.create({
    data: {
      id: host.id,
      messageId: host.id,
      conversationId: channelId,
      workspaceId,
      number: 500,
      title: "an older task",
      creatorMemberId: people.author.memberId,
    },
  });
  const { tasks } = await run({ operation: "list", status: "all" });
  const older = tasks.find((task) => task.number === 500);
  expect(older).toMatchObject({ earlierDiscussion: { threadRootId: host.id, replyCount: 1 } });
  expect(older!.discussionConversationId).toBeUndefined();
});

test("a task made for someone already carries its conversation, and notices are not replies", async () => {
  const { tasks } = await run({
    operation: "create",
    title: "For the author",
    assignee: `@${(await db.user.findUniqueOrThrow({ where: { id: people.author.id } })).username}`,
  });
  const made = tasks[0]!;
  // The assignment notice made the conversation; the task read back already points at it.
  expect(made.discussionConversationId).toBeString();
  const listed = async () =>
    (await run({ operation: "list", status: "all" })).tasks.find(
      (task) => task.number === made.number,
    )!;
  expect((await listed()).replyCount).toBe(0);
  const seat = await db.conversationMember.create({
    data: {
      workspaceId,
      conversationId: made.discussionConversationId!,
      userId: people.author.id,
    },
  });
  await db.message.create({
    data: {
      conversationId: made.discussionConversationId!,
      workspaceId,
      senderMemberId: seat.id,
      body: "on it",
      sequence: 50,
    },
  });
  expect((await listed()).replyCount).toBe(1);
});
