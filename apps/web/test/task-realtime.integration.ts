import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import {
  CentrifugoConversationRealtime,
  type TaskChangedSignal,
} from "#src/server/conversations/conversation-realtime.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";
import { workspaceConversationChannel } from "#src/features/conversations/conversation-realtime";
import { decodeTaskChangedEvent } from "#src/features/tasks/task-realtime";
import { withPublishBatch, withPublishJsonBatch } from "./helpers/fake-centrifugo";
import { legacyMessageTask } from "./fixtures/legacy-message-task";

const connectionString = Bun.env.TASK_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
if (!connectionString)
  throw new Error("TASK_TEST_DATABASE_URL or DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const handle = crypto.randomUUID().slice(0, 8);
const cleanup: Array<() => Promise<unknown>> = [];

afterAll(async () => {
  for (const step of cleanup.reverse()) await step();
  await db.$disconnect();
});

/**
 * Every Task write announces the Tasks it changed, with their new copies, so an open Tasks page
 * updates those rows without reading its list again: a channel's Tasks to the whole Workspace, a
 * direct message's only to its human viewer.
 */
let alice: { id: string };
let agent: { id: string };
let workspaceId: string;
beforeAll(async () => {
  alice = await db.user.create({
    data: { displayName: `realtime-alice-${handle}`, username: `realtime-alice-${handle}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `task-realtime-${handle}`,
      name: "Task realtime",
      members: { create: [{ userId: alice.id, role: "owner" }] },
      agents: {
        create: {
          name: `realtime-agent-${handle}`,
          displayName: "Realtime Agent",
          ownerId: alice.id,
          runtimeConfig: {},
        },
      },
    },
    include: { agents: true },
  });
  workspaceId = workspace.id;
  agent = workspace.agents[0]!;
  cleanup.push(
    () => db.user.deleteMany({ where: { id: alice.id } }),
    () => db.workspace.delete({ where: { id: workspace.id } }),
  );
});

async function boardFor(
  conversation: {
    channelName?: string;
    directKey?: string;
    visibility?: "private";
  },
  options: {
    workspaceId?: string;
    agent?: boolean;
    taskChanged?: (signal: TaskChangedSignal) => void | Promise<void>;
  } = {},
) {
  const wsId = options.workspaceId ?? workspaceId;
  const created = await db.conversation.create({
    data: {
      workspaceId: wsId,
      ...conversation,
      members: {
        create: [{ userId: alice.id }, ...(options.agent === false ? [] : [{ agentId: agent.id }])],
      },
    },
  });
  const announced: TaskChangedSignal[] = [];
  const board = new TaskBoard(db, {
    realtime: {
      async memberChanged() {},
      async messageAvailable() {},
      async taskChanged(signal) {
        if (options.taskChanged) return options.taskChanged(signal);
        announced.push(signal);
      },
    },
  });
  const run = (command: Record<string, unknown>) =>
    board.execute({ workspaceId: wsId, userId: alice.id }, {
      idempotencyKey: crypto.randomUUID(),
      conversationId: created.id,
      ...command,
    } as Parameters<TaskBoard["execute"]>[1]);
  /** What was announced since the last call, as (Task number, status, revision) and deletions. */
  const drain = () => {
    const signals = announced.splice(0);
    return signals.map((signal) => ({
      tasks: signal.tasks.map((task) => [task.number, task.status, task.revision]),
      deleted: signal.deleted,
      userId: signal.userId,
    }));
  };
  return { run, drain, announced };
}

test("a channel's Task writes announce each changed Task to the Workspace, once per write", async () => {
  const { run, drain } = await boardFor({ channelName: `realtime-${handle}` });
  const [first, second] = (await run({ operation: "create", titles: ["One", "Two"] })).tasks;
  expect(drain()).toEqual([
    {
      tasks: [
        [first!.number, "todo", first!.revision],
        [second!.number, "todo", second!.revision],
      ],
      deleted: [],
      userId: undefined,
    },
  ]);

  const claimed = (await run({ operation: "claim", number: first!.number })).tasks[0]!;
  await run({ operation: "update", number: first!.number, status: "backlog" });
  await run({ operation: "update", number: first!.number, status: "backlog" });
  expect(drain()).toEqual([
    { tasks: [[first!.number, "in_progress", claimed.revision]], deleted: [], userId: undefined },
    {
      tasks: [[first!.number, "backlog", claimed.revision + 1]],
      deleted: [],
      userId: undefined,
    },
    {
      tasks: [[first!.number, "backlog", claimed.revision + 2]],
      deleted: [],
      userId: undefined,
    },
  ]);

  await run({ operation: "delete", number: second!.number });
  expect(drain()).toEqual([{ tasks: [], deleted: [second!.id], userId: undefined }]);
});

test("a Task made under a parent announces the parent's new copy with it", async () => {
  const { run, announced } = await boardFor(
    { channelName: `realtime-parent-${handle}` },
    { agent: false },
  );
  const [parent] = (await run({ operation: "create", titles: ["Parent"] })).tasks;
  announced.length = 0;
  const [child] = (
    await run({
      operation: "create",
      title: "Child",
      parent: { number: parent!.number },
    })
  ).tasks;
  const change = announced.find((signal) =>
    signal.tasks.some((task) => task.number === child!.number),
  );
  expect(change).toBeDefined();
  const copies = new Map(change!.tasks.map((task) => [task.number, task]));
  expect(copies.get(parent!.number)).toMatchObject({
    revision: parent!.revision,
    subtasks: { total: 1, finished: 0 },
  });
  expect(copies.get(child!.number)?.parent).toMatchObject({
    hidden: false,
    number: parent!.number,
  });
});

test("a failed announcement does not fail the create that committed", async () => {
  const parentChannel = `realtime-parent-out-${handle}`;
  const { run: parentRun } = await boardFor({ channelName: parentChannel }, { agent: false });
  const { run } = await boardFor(
    { channelName: `realtime-child-out-${handle}` },
    {
      agent: false,
      taskChanged: () => {
        throw new Error("centrifugo is down");
      },
    },
  );
  const [parent] = (await parentRun({ operation: "create", titles: ["Parent"] })).tasks;
  const created = await run({
    operation: "create",
    title: "Child",
    parent: { number: parent!.number, channel: parentChannel },
  });
  expect(created.tasks).toHaveLength(1);
  expect(created.tasks[0]!.parent).toMatchObject({
    hidden: false,
    number: parent!.number,
    channel: parentChannel,
  });
});

test("a private channel's Task writes are announced only to its people, never the Workspace", async () => {
  const { run, announced } = await boardFor({
    channelName: `realtime-private-${handle}`,
    visibility: "private",
  });
  const [task] = (await run({ operation: "create", titles: ["Secret"] })).tasks;
  await run({ operation: "claim", number: task!.number });
  await run({ operation: "amend", number: task!.number, title: "Still secret" });
  await run({ operation: "update", number: task!.number, status: "backlog" });
  await run({ operation: "delete", number: task!.number });
  expect(announced.length).toBeGreaterThanOrEqual(5);
  for (const signal of announced)
    expect(signal).toMatchObject({ workspaceId, memberUserIds: [alice.id] });
});

test("a direct message's Task writes are announced only to its human viewer", async () => {
  const { run, announced } = await boardFor({ directKey: `${alice.id}:${agent.id}` });
  await run({ operation: "create", title: "Private work" });
  expect(announced).toHaveLength(1);
  expect(announced[0]).toMatchObject({ workspaceId, userId: alice.id, agentId: agent.id });
});

test("a Task write's announcement and its message signal never share a publication key on a channel", async () => {
  const conversation = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `realtime-keys-${handle}`,
      members: { create: [{ userId: alice.id }, { agentId: agent.id }] },
    },
  });
  // Centrifugo drops a second publication with the same key on the same channel.
  const published: string[] = [];
  const centrifugo = withPublishJsonBatch(
    withPublishBatch({
      async publish() {},
      async broadcast() {},
      async publishJson(channel: string, _data: unknown, key?: string) {
        published.push(`${channel} ${key}`);
      },
    }),
  );
  const board = new TaskBoard(db, { realtime: new CentrifugoConversationRealtime(centrifugo) });
  const run = (command: Record<string, unknown>) =>
    board.execute({ workspaceId, userId: alice.id }, {
      idempotencyKey: crypto.randomUUID(),
      conversationId: conversation.id,
      ...command,
    } as Parameters<TaskBoard["execute"]>[1]);
  const creator = await db.conversationMember.findFirstOrThrow({
    where: { conversationId: conversation.id, userId: alice.id },
  });
  const { task: created } = await legacyMessageTask(db, {
    conversationId: conversation.id,
    workspaceId,
    creatorMemberId: creator.id,
    title: "Keyed",
  });
  await run({ operation: "claim", number: created.number });
  await run({ operation: "unclaim", number: created.number });
  await run({ operation: "delete", number: created.number });
  // The Workspace channel carries the Task announcements only: a message signal goes to the
  // conversation's own channel (task #285), so three writes that change the Task are three
  // publications here.
  expect(published.filter((entry) => entry.startsWith("chat:workspace:")).length).toBe(3);
  // That conversation's channel carries both kinds, and no two share a key — Centrifugo drops a
  // second publication with the same key on the same channel.
  expect(
    published.filter((entry) => entry.startsWith(`chat:${conversation.id} `)).length,
  ).toBeGreaterThan(1);
  expect(new Set(published).size).toBe(published.length);
});

test("a direct conversation without exactly one person and one Agent announces its Tasks nowhere", async () => {
  // The member rows can go (a hard-deleted user); its Tasks must not fall back to the Workspace.
  const lonely = await db.conversation.create({
    data: {
      workspaceId,
      directKey: `${alice.id}:${crypto.randomUUID()}`,
      members: { create: [{ userId: alice.id }] },
    },
  });
  const announced: TaskChangedSignal[] = [];
  const board = new TaskBoard(db, {
    realtime: {
      async memberChanged() {},
      async messageAvailable() {},
      async taskChanged(signal) {
        announced.push(signal);
      },
    },
  });
  await board.execute({ workspaceId, userId: alice.id }, {
    idempotencyKey: crypto.randomUUID(),
    conversationId: lonely.id,
    operation: "create",
    title: "Nowhere",
  } as Parameters<TaskBoard["execute"]>[1]);
  expect(announced).toEqual([]);
});

test("a sub-task made in a Task popup pushes its parent's new copy to the channel", async () => {
  // What the popup's sub-task dialog sends (`useTaskRelations.createSubtasks`): a `create` with a
  // parent, as a person's browser issues it — through the Centrifugo port, on the channel the
  // open popup listens to. The parent's own row does not change; its progress does.
  const pushed: Array<{ channel: string; data: unknown }> = [];
  const centrifugo = withPublishJsonBatch(
    withPublishBatch({
      async publish() {},
      async broadcast() {},
      async publishJson(channel: string, data: unknown) {
        pushed.push({ channel, data });
      },
    }),
  );
  const conversation = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `realtime-popup-${handle}`,
      members: { create: [{ userId: alice.id }] },
    },
  });
  cleanup.push(() => db.conversation.delete({ where: { id: conversation.id } }));
  const board = new TaskBoard(db, {
    realtime: new CentrifugoConversationRealtime(centrifugo),
    publisher: centrifugo,
  });
  const run = (command: Record<string, unknown>) =>
    board.execute({ workspaceId, userId: alice.id }, {
      idempotencyKey: crypto.randomUUID(),
      conversationId: conversation.id,
      ...command,
    } as Parameters<TaskBoard["execute"]>[1]);
  const [parent] = (await run({ operation: "create", titles: ["Parent"] })).tasks;
  pushed.length = 0;
  const [child] = (
    await run({ operation: "create", title: "Child", parent: { number: parent!.number } })
  ).tasks;

  const changes = pushed
    .map(({ channel, data }) => ({
      channel,
      event: data as {
        type: string;
        tasks: Array<{ number: number; revision: number; subtasks: unknown }>;
      },
    }))
    .filter(({ event }) => event.type === "task.changed.v1");
  expect(changes).toHaveLength(1);
  expect(changes[0]!.channel).toBe(workspaceConversationChannel(workspaceId));
  const copies = new Map(changes[0]!.event.tasks.map((task) => [task.number, task]));
  expect(copies.get(parent!.number)).toMatchObject({
    revision: parent!.revision,
    subtasks: { total: 1, finished: 0 },
  });
  expect(copies.get(child!.number)).toBeDefined();
  // The browser's own decoder reads the publication as announced Tasks, sub-task progress and all.
  const decoded = decodeTaskChangedEvent(changes[0]!.event);
  expect(decoded?.tasks.find((task) => task.number === parent!.number)).toMatchObject({
    subtasks: { total: 1, finished: 0 },
  });
});
