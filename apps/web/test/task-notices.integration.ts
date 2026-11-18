import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { TaskBoard } from "#src/server/tasks/task-board.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";

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
 * One Workspace for every test here: Alice (owner, display name "Alice An"), Bob (member, no
 * display name, so he is named by his username), and an Agent. Each test takes its own channel.
 */
let alice: { id: string; username: string };
let bob: { id: string; username: string };
let agent: { id: string; name: string };
let workspaceId: string;
beforeAll(async () => {
  alice = await db.user.create({
    data: { username: `notice-alice-${handle}`, displayName: "Alice An" },
  });
  bob = await db.user.create({
    data: { displayName: `notice-bob-${handle}`, username: `notice-bob-${handle}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `task-notices-${handle}`,
      name: "Task notices",
      members: {
        create: [
          { userId: alice.id, role: "owner" },
          { userId: bob.id, role: "member" },
        ],
      },
      agents: {
        create: {
          name: `notice-agent-${handle}`,
          displayName: "Notice Agent",
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
    () => db.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } }),
    () => db.workspace.delete({ where: { id: workspace.id } }),
  );
});

async function channelFixture(name: string) {
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `${name}-${handle}`,
      members: {
        create: [{ userId: alice.id }, { userId: bob.id }, { agentId: agent.id }],
      },
    },
    include: { members: true },
  });
  const board = new TaskBoard(db);
  type Principal =
    | { workspaceId: string; userId: string }
    | { workspaceId: string; agentId: string };
  const run = (principal: Principal, command: Record<string, unknown>) =>
    board.execute(principal, {
      idempotencyKey: crypto.randomUUID(),
      ...("agentId" in principal
        ? { target: `#${channel.channelName}` }
        : { conversationId: channel.id }),
      ...command,
    } as Parameters<TaskBoard["execute"]>[1]);
  /** The server notices in a Task's own conversation, oldest first. */
  const noticesOf = async (task: { number: number }) => {
    const { discussionConversationId } = await db.task.findFirstOrThrow({
      where: { conversationId: channel.id, number: task.number },
      select: { discussionConversationId: true },
    });
    if (!discussionConversationId) return [];
    return (
      await db.message.findMany({
        where: { conversationId: discussionConversationId, senderMemberId: null },
        orderBy: { sequence: "asc" },
        select: { body: true, threadRootId: true },
      })
    ).map(({ body, threadRootId }) => ({ body, thread: threadRootId }));
  };
  /** Every server notice in the Tasks' conversations, with its delivery count. */
  const allNotices = () =>
    db.message.findMany({
      where: {
        senderMemberId: null,
        conversation: { kind: "task_thread", taskDiscussionOf: { conversationId: channel.id } },
      },
      select: { id: true, conversationId: true, _count: { select: { deliveries: true } } },
    });
  const memberId = (by: { userId?: string; agentId?: string }) =>
    channel.members.find((member) =>
      by.userId ? member.userId === by.userId : member.agentId === by.agentId,
    )!.id;
  const createTasks = async (principal: Principal, titles: string[]) => {
    const tasks = [];
    for (const title of titles)
      tasks.push((await run(principal, { operation: "create", title })).tasks[0]!);
    return tasks;
  };
  return {
    channel,
    createTasks,
    run,
    noticesOf,
    allNotices,
    memberId,
    asAlice: { workspaceId, userId: alice.id },
    asBob: { workspaceId, userId: bob.id },
    asAgent: { workspaceId, agentId: agent.id },
  };
}

test("claims, moves and unassignment post in the Task's own conversation", async () => {
  const { run, createTasks, noticesOf, asAlice, asBob, asAgent } = await channelFixture("thread");
  const [shipTask, docsTask, testsTask] = await createTasks(asAlice, [
    "Ship notices",
    "Write docs",
    "Add tests",
  ]);
  const own = (body: string) => ({ body, thread: null });
  const newSince = async (task: { number: number }, seen: number) =>
    (await noticesOf(task)).slice(seen);

  // Claiming an unassigned Todo Task moves it to In Progress and says so once, as a claim.
  await run(asAgent, { operation: "claim", number: shipTask!.number });
  expect(await noticesOf(shipTask!)).toEqual([
    own(`📌 ${agent.name} claimed #${shipTask!.number} "Ship notices"`),
  ]);

  // Each status move names the actor by display name and the status by its label.
  await run(asAgent, { operation: "update", number: shipTask!.number, status: "in_review" });
  await run(asAgent, { operation: "update", number: shipTask!.number, status: "in_progress" });
  await run(asAlice, { operation: "update", number: shipTask!.number, status: "done" });
  await run(asAlice, { operation: "update", number: shipTask!.number, status: "todo" });
  await run(asAlice, { operation: "update", number: shipTask!.number, status: "closed" });
  // A status that does not change posts nothing.
  await run(asAlice, { operation: "update", number: shipTask!.number, status: "closed" });
  const moved = (actor: string, emoji: string, label: string) =>
    own(`${emoji} ${actor} moved #${shipTask!.number} "Ship notices" to ${label}`);
  expect(await newSince(shipTask!, 1)).toEqual([
    moved("Notice Agent", "👀", "In Review"),
    moved("Notice Agent", "🔄", "In Progress"),
    moved("Alice An", "✅", "Done"),
    moved("Alice An", "📝", "Todo"),
    moved("Alice An", "🚫", "Closed"),
  ]);

  // Clearing an assignee, by `unassign` or by assigning no one, names the actor.
  await run(asAlice, {
    operation: "assign",
    number: docsTask!.number,
    assignee: `@${bob.username}`,
  });
  const seen = (await noticesOf(docsTask!)).length;
  await run(asAlice, { operation: "unassign", number: docsTask!.number });
  await run(asAlice, {
    operation: "assign",
    number: docsTask!.number,
    assignee: `@${bob.username}`,
  });
  await run(asAlice, { operation: "assign", number: docsTask!.number, assignee: null });
  const unassigned = own(`🔓 Alice An unassigned #${docsTask!.number} "Write docs"`);
  expect(await newSince(docsTask!, seen)).toEqual([
    unassigned,
    own(`📌 Alice An assigned #${docsTask!.number} "Write docs" to @${bob.username}`),
    unassigned,
  ]);

  // A member without a display name is named by username.
  await run(asBob, { operation: "claim", number: testsTask!.number });
  const claimed = (await noticesOf(testsTask!)).length;
  await run(asBob, { operation: "update", number: testsTask!.number, status: "in_review" });
  expect(await newSince(testsTask!, claimed)).toEqual([
    own(`👀 ${bob.username} moved #${testsTask!.number} "Add tests" to In Review`),
  ]);
});

test("unclaiming and deleting a Task post no notice", async () => {
  const { run, allNotices, asAlice, asBob } = await channelFixture("silent");
  const task = (await run(asAlice, { operation: "create", title: "Quiet task" })).tasks[0]!;
  await run(asBob, { operation: "claim", number: task.number });
  const before = (await allNotices()).length;
  await run(asBob, { operation: "unclaim", number: task.number });
  await run(asAlice, { operation: "delete", number: task.number });
  expect((await allNotices()).length).toBe(before);
});

test("only the assignment receipt is delivered", async () => {
  const { run, noticesOf, allNotices, createTasks, asAlice, asAgent } =
    await channelFixture("receipts");
  const [startedTask, reservedTask] = await createTasks(asAlice, ["Started by me", "Reserved"]);

  // Assigned to oneself, a Task's receipt is the one assignment notice, in the Task's own conversation.
  const started = await run(asAgent, {
    operation: "assign",
    number: startedTask!.number,
    assignee: `@${agent.name}`,
  });
  const startedLine = `📌 Notice Agent assigned #${startedTask!.number} "Started by me" to @${agent.name}`;
  expect(await noticesOf(startedTask!)).toEqual([
    // An Agent's own assignment carries its queue note (task #716); earlier tests leave the
    // Agent other queued Tasks, so the position is not pinned here.
    { body: expect.stringContaining(startedLine), thread: null },
  ]);
  expect(started.assignmentReceipts).toEqual([
    expect.objectContaining({ content: expect.stringContaining(startedLine) }),
  ]);

  // Reserved for someone else, it is the same assignment notice.
  const reserved = await run(asAlice, {
    operation: "assign",
    number: reservedTask!.number,
    assignee: `@${agent.name}`,
  });
  const assignLine = `📌 Alice An assigned #${reservedTask!.number} "Reserved" to @${agent.name} — do it first`;
  expect(await noticesOf(reservedTask!)).toEqual([{ body: assignLine, thread: null }]);
  expect(reserved.assignmentReceipts).toEqual([
    expect.objectContaining({ state: "assigned", content: assignLine }),
  ]);

  await run(asAlice, { operation: "update", number: reservedTask!.number, status: "closed" });
  await run(asAlice, { operation: "unassign", number: reservedTask!.number });

  const notices = await allNotices();
  // Only the receipt of a person's assignment is delivered to the Agent: an Agent that assigns
  // itself never wakes itself.
  expect(
    notices
      .filter((notice) => notice._count.deliveries > 0)
      .map((notice) => [notice.id, notice._count.deliveries]),
  ).toEqual([[reserved.assignmentReceipts![0]!.messageId, 1]]);
});

test("a receipt lands in the Task's own conversation: the assignee follows the Task, an Agent assignee gets its one delivery there", async () => {
  const { channel, run, memberId, createTasks, asAlice } = await channelFixture("receipt-target");
  const [first, second] = await createTasks(asAlice, ["Review the plan", "For the Agent"]);
  const messagesInChannel = () => db.message.count({ where: { conversationId: channel.id } });
  const before = await messagesInChannel();

  const forBob = await run(asAlice, {
    operation: "assign",
    number: first!.number,
    assignee: `@${bob.username}`,
  });
  const bobReceipt = forBob.assignmentReceipts![0]!;
  const stored = await db.message.findUniqueOrThrow({
    where: { id: bobReceipt.messageId },
    select: {
      body: true,
      threadRootId: true,
      conversation: { select: { kind: true, taskDiscussionOf: { select: { number: true } } } },
      _count: { select: { deliveries: true } },
    },
  });
  expect(stored).toEqual({
    body: bobReceipt.content,
    threadRootId: null,
    conversation: { kind: "task_thread", taskDiscussionOf: { number: first!.number } },
    _count: { deliveries: 0 },
  });
  expect(
    await db.taskFollow.count({
      where: { memberId: memberId({ userId: bob.id }), task: { number: first!.number } },
    }),
  ).toBe(1);

  const forAgent = await run(asAlice, {
    operation: "assign",
    number: second!.number,
    assignee: `@${agent.name}`,
  });
  const agentReceipt = forAgent.assignmentReceipts![0]!;
  const pending = await new PrismaDirectConversationRepository(db).readPendingAgentDeliveries(
    workspaceId,
    agent.id,
  );
  const taskConversation = await db.task.findFirstOrThrow({
    where: { conversationId: channel.id, number: second!.number },
    select: { discussionConversationId: true },
  });
  expect(pending.filter((delivery) => delivery.messageId === agentReceipt.messageId)).toEqual([
    expect.objectContaining({
      body: agentReceipt.content,
      conversationId: taskConversation.discussionConversationId,
      target: `#${channel.channelName}:#${second!.number}`,
    }),
  ]);
  expect(await messagesInChannel()).toBe(before);
});
