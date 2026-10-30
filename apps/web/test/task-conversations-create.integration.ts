import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PrismaExperimentsRepository } from "#src/server/experiments/experiments.repositories.server";
import { readFeatureFlagsConfiguration } from "#src/server/feature-flags/configuration.server";
import { installFeatureFlags } from "#src/server/feature-flags/feature-flags.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";
import { SourceMessageTaken } from "#src/server/tasks/task-conversation-creation.server";

const connectionString = Bun.env.TASK_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
if (!connectionString) throw new Error("TASK_TEST_DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const suffix = crypto.randomUUID().slice(0, 8);
let directory = "";
let workspaceId = "";
let channelId = "";
let channelName = "";
let sourceId = "";
const agents = {} as Record<"maker" | "worker", { id: string; name: string; memberId: string }>;
const board = new TaskBoard(db, { reader: "agent" });
const as = (key: keyof typeof agents) => ({ workspaceId, agentId: agents[key].id });
const run = (key: keyof typeof agents, command: Record<string, unknown>) =>
  board.execute(as(key), {
    idempotencyKey: crypto.randomUUID(),
    target: `#${channelName}`,
    ...command,
  } as Parameters<TaskBoard["execute"]>[1]);

beforeAll(async () => {
  const owner = await db.user.create({
    data: { username: `tcc-owner-${suffix}`, displayName: "Owner" },
  });
  channelName = `tcc-${suffix}`;
  const workspace = await db.workspace.create({
    data: {
      slug: `task-conv-create-${suffix}`,
      name: "Task conversation create",
      members: { create: { userId: owner.id, role: "owner" } },
      agents: {
        create: ["maker", "worker"].map((key) => ({
          name: `tcc-${key}-${suffix}`,
          displayName: key,
          ownerId: owner.id,
          runtimeConfig: {},
          // The maker may assign others.
          role: key === "maker" ? "admin" : "member",
        })),
      },
    },
    include: { agents: true },
  });
  workspaceId = workspace.id;
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName,
      members: { create: workspace.agents.map((agent) => ({ agentId: agent.id })) },
    },
    include: { members: true },
  });
  channelId = channel.id;
  for (const key of ["maker", "worker"] as const) {
    const agent = workspace.agents.find((candidate) => candidate.name.includes(`-${key}-`))!;
    agents[key] = {
      id: agent.id,
      name: agent.name,
      memberId: channel.members.find((member) => member.agentId === agent.id)!.id,
    };
  }
  const source = await db.message.create({
    data: {
      conversationId: channelId,
      workspaceId,
      senderMemberId: agents.maker.memberId,
      body: "please fix the login page",
      sequence: 1,
    },
  });
  sourceId = source.id;
  directory = await mkdtemp(join(tmpdir(), "coforge-task-conv-create-"));
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
});

afterAll(async () => {
  await installFeatureFlags({ status: "disabled" });
  await rm(directory, { recursive: true, force: true });
  await db.workspace.delete({ where: { id: workspaceId } });
  await db.$disconnect();
});

const experiment = (enabled: boolean) =>
  new PrismaExperimentsRepository(db).write(workspaceId, "taskConversations", enabled);

test("with the experiment off a message is still claimed as a task, as before", async () => {
  await experiment(false);
  const claimed = await run("worker", { operation: "claim", messageId: sourceId });
  expect(claimed.tasks[0]!.messageId).toBe(sourceId);
  await db.task.deleteMany({ where: { workspaceId } });
});

test("with it on, create makes a task with no message in the channel, followed by its creator", async () => {
  await experiment(true);
  const before = await db.message.count({ where: { conversationId: channelId } });
  const created = await run("maker", {
    operation: "create",
    title: "Fix the login page",
    messageId: sourceId,
    assignee: `@${agents.worker.name}`,
    description: "see the message",
  });
  const view = created.tasks[0]!;
  expect(view.status).toBe("todo");
  expect(view.owner?.handle).toBe(agents.worker.name);
  // No message in the channel: not for the task, not for the creation, not for the assignment.
  expect(await db.message.count({ where: { conversationId: channelId } })).toBe(before);

  const task = await db.task.findUniqueOrThrow({ where: { id: view.messageId } });
  expect(task.messageId).toBeNull();
  expect(task.sourceMessageId).toBe(sourceId);
  const follows = await db.taskFollow.findMany({ where: { taskId: task.id } });
  expect(follows.map((f) => [f.memberId, f.reason]).sort()).toEqual(
    [
      [agents.maker.memberId, "created"],
      [agents.worker.memberId, "assigned"],
    ].sort(),
  );
  // The assignee is told in the task's own conversation, and only the assignee's Agent is woken.
  const notice = await db.message.findFirstOrThrow({
    where: { conversation: { taskDiscussionOf: { id: task.id } } },
    include: { deliveries: true },
  });
  expect(notice.senderMemberId).toBeNull();
  expect(notice.deliveries.map((d) => d.agentId)).toEqual([agents.worker.id]);
  const history = await db.taskHistoryEvent.findMany({ where: { taskId: task.id } });
  expect(history.map((event) => event.eventType)).toEqual(["created", "assignee_changed"]);
});

test("a retried create answers with the first task", async () => {
  const command = { operation: "create", title: "Once", idempotencyKey: crypto.randomUUID() };
  const first = await run("maker", command);
  const retry = await run("maker", command);
  expect(retry.tasks[0]!.messageId).toBe(first.tasks[0]!.messageId);
  expect(await db.task.count({ where: { workspaceId, title: "Once" } })).toBe(1);
});

test("someone else's live task on the message is named, and alongside makes another", async () => {
  await expect(
    run("maker", { operation: "create", title: "Same message", messageId: sourceId }),
  ).rejects.toBeInstanceOf(SourceMessageTaken);
  // The holder building on their own message is not blocked.
  const mine = await run("worker", { operation: "create", title: "Mine too", messageId: sourceId });
  expect(mine.tasks).toHaveLength(1);
  const beside = await run("maker", {
    operation: "create",
    title: "Beside",
    messageId: sourceId,
    alongside: true,
  });
  expect(beside.tasks).toHaveLength(1);
  expect(await db.task.count({ where: { sourceMessageId: sourceId } })).toBe(3);
});

test("claim by message and convert are refused, pointing at create", async () => {
  for (const command of [
    { operation: "claim", messageId: sourceId },
    { operation: "convert", messageId: sourceId },
  ])
    await expect(run("worker", command)).rejects.toMatchObject({
      code: "CONFLICT",
      errorId: "task_v2_use_create",
    });
  // Claiming a task by its number is unchanged.
  const created = await run("maker", { operation: "create", title: "By number" });
  const claimed = await run("worker", { operation: "claim", number: created.tasks[0]!.number });
  expect(claimed.tasks[0]!.owner?.handle).toBe(agents.worker.name);
});

test("a source message from another channel is not found", async () => {
  const other = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `tcc-other-${suffix}`,
      members: { create: [{ agentId: agents.maker.id }] },
    },
  });
  const foreign = await db.message.create({
    data: { conversationId: other.id, workspaceId, body: "elsewhere", sequence: 1 },
  });
  await expect(
    run("maker", { operation: "create", title: "Leak", messageId: foreign.id }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("a person keeps the message-based flow, and a source needs the experiment", async () => {
  await db.workspaceMembership.updateMany({ where: { workspaceId }, data: { role: "owner" } });
  await experiment(false);
  await expect(
    run("maker", { operation: "create", title: "x", messageId: sourceId }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  await experiment(true);
  await expect(
    run("maker", { operation: "create", title: "x", alongside: true }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  await expect(
    run("maker", { operation: "create", title: "x", createsResource: true }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
});
