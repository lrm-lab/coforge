import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { agentTaskBoardFreshness } from "#src/server/agents/agent-task-freshness.server";
import { getOrCreateAgentPeerConversation } from "#src/server/db/repositories/agent-peer-direct.repositories.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { handleAgentTaskPost } from "#src/routes/api/agent/v1/tasks";
import { TaskBoard } from "#src/server/tasks/task-board.server";
import { agentTaskPrincipal } from "#src/server/tasks/task-principal.server";
import { TASK_SOURCE_MESSAGE_REQUIRED } from "#src/server/tasks/task-assign-reason.server";
import {
  TASK_CREATES_RESOURCE_RETIRED,
  TASK_NOT_RESOURCE,
} from "#src/server/tasks/task-resource-receipt.server";

const connectionString = Bun.env.TASK_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
if (!connectionString) throw new Error("TASK_TEST_DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const suffix = crypto.randomUUID().slice(0, 8);
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
});

afterAll(async () => {
  await db.workspace.delete({ where: { id: workspaceId } });
  await db.$disconnect();
});

test("create makes a task with no message in the channel, followed by its creator", async () => {
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

  const task = await db.task.findUniqueOrThrow({ where: { id: view.id } });
  expect(task.messageId).toBeNull();
  expect(view.messageId).toBeNull();
  expect(view.sourceMessage).toMatchObject({
    messageId: sourceId,
    senderName: expect.any(String),
    preview: expect.any(String),
  });
  expect(view.id).toBe(task.id);
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
  // First in the worker's queue: numbered, with nobody ahead (task #716).
  expect(notice.body).toContain("queue #1");
  expect(notice.body).not.toContain("ahead");
  // The body says "you" to the worker; the stored notice names them, so the conversation can say
  // who it went to (task #92).
  const stored = await db.systemMessage.findUniqueOrThrow({ where: { messageId: notice.id } });
  expect(stored.kind).toBe("task.assigned_you");
  expect(stored.params).toMatchObject({
    assignee: { memberId: agents.worker.memberId, handle: agents.worker.name },
  });
  const history = await db.taskHistoryEvent.findMany({
    where: { taskId: task.id },
    orderBy: { seq: "asc" },
  });
  expect(history.map((event) => event.eventType)).toEqual([
    "created",
    "assignee_changed",
    "priority_changed",
  ]);
  expect(history[2]!.payload).toEqual({ from: "none", to: "medium" });
});

test("Agent create from a reply records its top-level message as the source", async () => {
  const root = await db.message.create({
    data: {
      workspaceId,
      conversationId: channelId,
      senderMemberId: agents.maker.memberId,
      body: "A separate request",
      sequence: 2,
    },
  });
  const reply = await db.message.create({
    data: {
      workspaceId,
      conversationId: channelId,
      senderMemberId: agents.maker.memberId,
      body: "Follow-up request",
      threadRootId: root.id,
      sequence: 3,
    },
  });
  const [created] = (
    await run("maker", { operation: "create", title: "Reply task", messageId: reply.id })
  ).tasks;
  expect(created?.sourceMessageId).toBe(root.id);
  expect(created?.sourceMessage?.messageId).toBe(root.id);
});

test("a retried create answers with the first task", async () => {
  const command = {
    operation: "create",
    title: "Once",
    messageId: sourceId,
    idempotencyKey: crypto.randomUUID(),
  };
  const first = await run("maker", command);
  const retry = await run("maker", command);
  expect(retry.tasks[0]!.id).toBe(first.tasks[0]!.id);
  expect(await db.task.count({ where: { workspaceId, title: "Once" } })).toBe(1);
});

test("an Agent create without --message-id is refused with TASK_SOURCE_MESSAGE_REQUIRED", async () => {
  await expect(
    run("maker", { operation: "create", title: "Missing source" }),
  ).rejects.toMatchObject({
    code: "INVALID_INPUT",
    errorId: TASK_SOURCE_MESSAGE_REQUIRED,
  });
});

test("multiple tasks can be created from the same source message with or without alongside", async () => {
  const second = await run("maker", {
    operation: "create",
    title: "Same message",
    messageId: sourceId,
  });
  expect(second.tasks).toHaveLength(1);
  const mine = await run("worker", { operation: "create", title: "Mine too", messageId: sourceId });
  expect(mine.tasks).toHaveLength(1);
  const beside = await run("maker", {
    operation: "create",
    title: "Beside",
    messageId: sourceId,
    alongside: true,
  });
  expect(beside.tasks).toHaveLength(1);
  expect(await db.task.count({ where: { sourceMessageId: sourceId } })).toBe(5);
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
  const created = await run("maker", {
    operation: "create",
    title: "By number",
    messageId: sourceId,
  });
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

test("the assignee's queue note reads the new task's links: a blocked task gets none", async () => {
  const blocker = await run("maker", {
    operation: "create",
    title: "Queue blocker",
    messageId: sourceId,
  });
  const blocked = await run("maker", {
    operation: "create",
    title: "Queue blocked",
    messageId: sourceId,
    assignee: `@${agents.worker.name}`,
    blockedBy: [{ number: blocker.tasks[0]!.number }],
  });
  const blockedTask = await db.task.findUniqueOrThrow({
    where: { id: blocked.tasks[0]!.id },
  });
  const notice = await db.message.findFirstOrThrow({
    where: { conversation: { taskDiscussionOf: { id: blockedTask.id } } },
  });
  expect(notice.body).not.toContain("queue #");
  expect(notice.body).not.toContain("do it first");
  const queued = await run("maker", {
    operation: "create",
    title: "Queue third",
    messageId: sourceId,
    assignee: `@${agents.worker.name}`,
  });
  const queuedTask = await db.task.findUniqueOrThrow({ where: { id: queued.tasks[0]!.id } });
  const queuedNotice = await db.message.findFirstOrThrow({
    where: { conversation: { taskDiscussionOf: { id: queuedTask.id } } },
  });
  expect(queuedNotice.body).toMatch(/queue #\d+ \(ahead: #\d+/);
});

test("alongside needs a source message, and a create cannot create a resource", async () => {
  await db.workspaceMembership.updateMany({ where: { workspaceId }, data: { role: "owner" } });
  await expect(
    run("maker", { operation: "create", title: "x", alongside: true }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  await expect(
    run("maker", { operation: "create", title: "x", messageId: sourceId, createsResource: true }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT", errorId: TASK_CREATES_RESOURCE_RETIRED });
});

test("a receipt on a task that is not a resource task says so instead of failing", async () => {
  const created = await run("maker", {
    operation: "create",
    title: "No resource",
    messageId: sourceId,
    priority: "low",
  });
  await expect(
    run("maker", {
      operation: "receipt",
      number: created.tasks[0]!.number,
      receipt: {
        object: "o",
        purpose: "p",
        teardownOwner: `@${agents.maker.name}`,
        securityPrivacy: "s",
        expiry: new Date(Date.now() + 86_400_000).toISOString(),
        runbook: "r",
        tracking: "t",
      },
    }),
  ).rejects.toMatchObject({ code: "CONFLICT", errorId: TASK_NOT_RESOURCE });
});

const post = (principal: object, body: Record<string, unknown>) =>
  handleAgentTaskPost(
    new Request("http://x/api/agent/v1/tasks", {
      method: "POST",
      body: JSON.stringify({
        idempotencyKey: crypto.randomUUID(),
        target: `#${channelName}`,
        ...body,
      }),
    }),
    agentTaskPrincipal(principal as { workspaceId: string; agentId: string }),
    board,
  );

test("over the Agent route: claim by message is a 409 pointing at create, never a 500", async () => {
  // The principal the Agent API authenticates names the owner beside the Agent.
  const principal = { ...as("worker"), userId: crypto.randomUUID() };
  for (const body of [
    { operation: "claim", messageId: sourceId },
    { operation: "claim", messageIds: [sourceId] },
    { operation: "claim", messageId: sourceId.slice(0, 13) },
    { operation: "convert", messageId: sourceId },
    { operation: "claim", messageId: "01a18ee9-cfb2" },
    { operation: "claim", messageId: "not-a-message-id" },
    { operation: "claim", messageId: crypto.randomUUID() },
    { operation: "claim", number: 1, messageId: sourceId },
  ]) {
    const response = await post(principal, body);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "CONFLICT",
      error: expect.stringContaining("coforge task create --message-id"),
    });
  }
});

test("over the Agent route: create names its source message whole or by its short id", async () => {
  const principal = { ...as("maker"), userId: crypto.randomUUID() };
  for (const messageId of [sourceId, sourceId.slice(0, 13)]) {
    const response = await post(principal, {
      operation: "create",
      title: `From ${messageId}`,
      messageId,
      alongside: true,
    });
    expect(response.status).toBe(200);
    const created = (await response.json()) as {
      tasks: Array<{ sourceMessage?: { messageId: string } }>;
    };
    expect(created.tasks[0]!.sourceMessage?.messageId).toBe(sourceId);
  }
});

test("a message id that names no message is a not-found result, never a 500", async () => {
  const worker = { ...as("worker"), userId: crypto.randomUUID() };
  const claim = await post(worker, { operation: "claim", messageId: "not-a-message-id" });
  expect(claim.status).toBe(409);
  const maker = { ...as("maker"), userId: crypto.randomUUID() };
  const create = await post(maker, {
    operation: "create",
    title: "t",
    messageId: "not-a-message-id",
  });
  expect(create.status).toBe(404);
});

test("createConversationTasks files a Task under an explicit Project and defaults an Agent's to none", async () => {
  const project = await db.project.create({
    data: { workspaceId, name: "Conv project", slug: `conv-${suffix}` },
  });
  const filed = await run("maker", {
    operation: "create",
    title: "Filed",
    messageId: sourceId,
    project: project.slug,
  });
  const unfiled = await run("maker", {
    operation: "create",
    title: "Unfiled",
    messageId: sourceId,
  });
  const tasks = await db.task.findMany({
    where: { workspaceId },
    select: { title: true, projectId: true },
    orderBy: { title: "asc" },
  });
  expect(tasks.find((task) => task.title === "Filed")!.projectId).toBe(project.id);
  expect(tasks.find((task) => task.title === "Unfiled")!.projectId).toBeNull();
  void filed;
  void unfiled;
});

test("over the Agent route: an Agent can create from the same peer DM it just read", async () => {
  const maker = agents.maker;
  const worker = agents.worker;
  const principal = as("maker");
  const direct = await getOrCreateAgentPeerConversation(db, workspaceId, maker.id, worker.id);
  const sender = await db.conversationMember.findUniqueOrThrow({
    where: { conversationId_agentId: { conversationId: direct.id, agentId: worker.id } },
  });
  const message = await db.message.create({
    data: {
      workspaceId,
      conversationId: direct.id,
      senderMemberId: sender.id,
      sequence: 1,
      body: "Please create a task from this message",
    },
  });
  await db.conversation.update({
    where: { id: direct.id },
    data: { lastSequence: message.sequence },
  });
  const repository = new PrismaDirectConversationRepository(db);
  const page = await repository.readMessagesPage(workspaceId, maker.id, `@${worker.name}~agent`, {
    around: message.id,
    limit: 1,
  });
  expect(page.messages.map(({ id }) => id)).toEqual([message.id]);

  const createFrom = (messageId: string) =>
    handleAgentTaskPost(
      new Request("http://127.0.0.1/api/agent/v1/tasks", {
        method: "POST",
        body: JSON.stringify({
          operation: "create",
          peerKind: "agent",
          target: `@${worker.name}`,
          idempotencyKey: crypto.randomUUID(),
          messageId,
          status: "backlog",
          title: "Create from an Agent DM",
          alongside: true,
        }),
      }),
      principal,
      board,
      (command) => agentTaskBoardFreshness(db, principal, command),
    );
  const results = [];
  for (const messageId of [message.id, message.id.slice(0, 13)]) {
    const response = await createFrom(messageId);
    const body = await response.json();
    results.push({
      status: response.status,
      code: body.code,
      source: body.tasks?.[0]?.sourceMessageId,
    });
  }
  expect(results).toEqual([
    { status: 200, code: undefined, source: message.id },
    { status: 200, code: undefined, source: message.id },
  ]);
  for (const messageId of [sourceId, sourceId.slice(0, 13), crypto.randomUUID()]) {
    const response = await createFrom(messageId);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      code: "NOT_FOUND",
      error:
        "the referenced task or message could not be found or accessed in the target conversation",
    });
  }
  expect(await db.task.count({ where: { conversationId: direct.id } })).toBe(2);
});
