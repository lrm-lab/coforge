import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import type { ConversationRealtimeMessage } from "#src/server/conversations/conversation-realtime.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";
import { PrismaWebPushSubscriptionStore } from "#src/server/notifications/prisma-web-push-subscriptions.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
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
  const signaled: ConversationRealtimeMessage[] = [];
  const pushed: string[] = [];
  const board = new TaskBoard(db, {
    realtime: {
      async memberChanged() {},
      async messageAvailable(event) {
        signaled.push(event);
      },
    },
    notifications: {
      async notifyMessage(messageId) {
        pushed.push(messageId);
      },
    },
  });
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
  const latestSequence = async () =>
    (
      await db.message.findFirst({
        where: { conversationId: channel.id },
        orderBy: { sequence: "desc" },
        select: { sequence: true },
      })
    )?.sequence ?? 0;
  /** Server notices posted after `sequence`, oldest first, with where each one landed. */
  const noticesAfter = async (sequence: number) =>
    (
      await db.message.findMany({
        where: { conversationId: channel.id, senderMemberId: null, sequence: { gt: sequence } },
        orderBy: { sequence: "asc" },
        select: { body: true, threadRootId: true },
      })
    ).map(({ body, threadRootId }) => ({ body, thread: threadRootId }));
  /** Every server notice in the channel, with its delivery count. */
  const allNotices = () =>
    db.message.findMany({
      where: { conversationId: channel.id, senderMemberId: null },
      select: { id: true, _count: { select: { deliveries: true } } },
    });
  const memberId = (by: { userId?: string; agentId?: string }) =>
    channel.members.find((member) =>
      by.userId ? member.userId === by.userId : member.agentId === by.agentId,
    )!.id;
  /** Tasks from before task conversations (each a message in the channel), made by `by`. */
  const legacyTasks = async (by: { userId: string }, titles: string[]) => {
    const tasks = [];
    for (const title of titles)
      tasks.push(
        (
          await legacyMessageTask(db, {
            conversationId: channel.id,
            workspaceId,
            creatorMemberId: memberId(by),
            title,
          })
        ).task,
      );
    return tasks;
  };
  return {
    channel,
    signaled,
    pushed,
    legacyTasks,
    run,
    latestSequence,
    noticesAfter,
    allNotices,
    memberId,
    asAlice: { workspaceId, userId: alice.id },
    asBob: { workspaceId, userId: bob.id },
    asAgent: { workspaceId, agentId: agent.id },
  };
}

test("claims, moves and unassignment post in the Task's own thread", async () => {
  const { run, latestSequence, noticesAfter, legacyTasks, asAlice, asBob, asAgent } =
    await channelFixture("thread");
  const [shipTask, docsTask, testsTask] = await legacyTasks({ userId: alice.id }, [
    "Ship notices",
    "Write docs",
    "Add tests",
  ]);
  const inThread = (task: typeof shipTask, body: string) => ({ body, thread: task!.messageId });

  // Claiming an unassigned Todo Task moves it to In Progress and says so once, as a claim.
  let mark = await latestSequence();
  await run(asAgent, { operation: "claim", number: shipTask!.number });
  expect(await noticesAfter(mark)).toEqual([
    inThread(shipTask, `📌 ${agent.name} claimed #${shipTask!.number} "Ship notices"`),
  ]);

  // Each status move names the actor by display name and the status by its label.
  mark = await latestSequence();
  await run(asAgent, { operation: "update", number: shipTask!.number, status: "in_review" });
  await run(asAgent, { operation: "update", number: shipTask!.number, status: "in_progress" });
  await run(asAlice, { operation: "update", number: shipTask!.number, status: "done" });
  await run(asAlice, { operation: "update", number: shipTask!.number, status: "todo" });
  await run(asAlice, { operation: "update", number: shipTask!.number, status: "closed" });
  // A status that does not change posts nothing.
  await run(asAlice, { operation: "update", number: shipTask!.number, status: "closed" });
  const moved = (actor: string, emoji: string, label: string) =>
    inThread(shipTask, `${emoji} ${actor} moved #${shipTask!.number} "Ship notices" to ${label}`);
  expect(await noticesAfter(mark)).toEqual([
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
  mark = await latestSequence();
  await run(asAlice, { operation: "unassign", number: docsTask!.number });
  await run(asAlice, {
    operation: "assign",
    number: docsTask!.number,
    assignee: `@${bob.username}`,
  });
  await run(asAlice, { operation: "assign", number: docsTask!.number, assignee: null });
  const unassigned = inThread(docsTask, `🔓 Alice An unassigned #${docsTask!.number} "Write docs"`);
  expect(await noticesAfter(mark)).toEqual([
    unassigned,
    inThread(
      docsTask,
      `📌 Alice An assigned #${docsTask!.number} "Write docs" to @${bob.username}`,
    ),
    unassigned,
  ]);

  // A member without a display name is named by username.
  await run(asBob, { operation: "claim", number: testsTask!.number });
  mark = await latestSequence();
  await run(asBob, { operation: "update", number: testsTask!.number, status: "in_review" });
  expect(await noticesAfter(mark)).toEqual([
    inThread(testsTask, `👀 ${bob.username} moved #${testsTask!.number} "Add tests" to In Review`),
  ]);
});

test("unclaiming and deleting a Task post no notice", async () => {
  const { run, latestSequence, noticesAfter, asAlice, asBob } = await channelFixture("silent");
  const task = (await run(asAlice, { operation: "create", title: "Quiet task" })).tasks[0]!;
  await run(asBob, { operation: "claim", number: task.number });
  const mark = await latestSequence();
  await run(asBob, { operation: "unclaim", number: task.number });
  await run(asAlice, { operation: "delete", number: task.number });
  expect(await noticesAfter(mark)).toEqual([]);
});

test("only the assignment receipt is delivered and pushed; no notice reaches a badge channel", async () => {
  const {
    channel,
    signaled,
    pushed,
    run,
    latestSequence,
    noticesAfter,
    allNotices,
    legacyTasks,
    asAlice,
    asAgent,
  } = await channelFixture("receipts");
  const [startedTask, reservedTask] = await legacyTasks({ userId: alice.id }, [
    "Started by me",
    "Reserved",
  ]);

  // Assigned to oneself, a Task's receipt is the one assignment notice, in the Task's own thread.
  let mark = await latestSequence();
  const started = await run(asAgent, {
    operation: "assign",
    number: startedTask!.number,
    assignee: `@${agent.name}`,
  });
  const startedLine = `📌 Notice Agent assigned #${startedTask!.number} "Started by me" to @${agent.name}`;
  expect(await noticesAfter(mark)).toEqual([
    // An Agent's own assignment carries its queue note (task #716); earlier tests leave the
    // Agent other queued Tasks, so the position is not pinned here.
    { body: expect.stringContaining(startedLine), thread: startedTask!.messageId },
  ]);
  expect(started.assignmentReceipts).toEqual([
    expect.objectContaining({ content: expect.stringContaining(startedLine) }),
  ]);

  // Reserved for someone else, it is the same assignment notice.
  mark = await latestSequence();
  const reserved = await run(asAlice, {
    operation: "assign",
    number: reservedTask!.number,
    assignee: `@${agent.name}`,
  });
  const assignLine = `📌 Alice An assigned #${reservedTask!.number} "Reserved" to @${agent.name} — do it first`;
  expect(await noticesAfter(mark)).toEqual([{ body: assignLine, thread: reservedTask!.messageId }]);
  expect(reserved.assignmentReceipts).toEqual([
    expect.objectContaining({ state: "assigned", content: assignLine }),
  ]);

  await run(asAlice, { operation: "update", number: reservedTask!.number, status: "closed" });
  await run(asAlice, { operation: "unassign", number: reservedTask!.number });

  const receiptIds = [started, reserved].map((result) => result.assignmentReceipts![0]!.messageId);
  const notices = await allNotices();
  // Each receipt carries its push; no other notice has one. Only the receipt of a person's
  // assignment is delivered to the Agent: an Agent that assigns itself never wakes itself.
  const receiptsFirst = [...receiptIds].sort();
  expect(
    notices
      .filter((notice) => notice._count.deliveries > 0)
      .map((notice) => [notice.id, notice._count.deliveries]),
  ).toEqual([[reserved.assignmentReceipts![0]!.messageId, 1]]);
  expect(pushed.filter((id) => notices.some((notice) => notice.id === id)).sort()).toEqual(
    receiptsFirst,
  );

  // No notice counts unread, the receipt included, so each reaches the open conversation only,
  // never the Workspace-wide signal that drives unread badges.
  for (const notice of notices) {
    const events = signaled.filter((event) => event.messageId === notice.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.conversationId).toBe(channel.id);
    expect(events[0]).not.toHaveProperty("workspaceId");
  }
});

test("an assignment receipt mentions its assignee: a muted human assignee is still pushed, and an Agent assignee reads it as its mention", async () => {
  const { channel, run, memberId, legacyTasks, asAlice } = await channelFixture("muted-assignee");
  const [first, second, third] = await legacyTasks({ userId: alice.id }, [
    "Review the plan",
    "Second",
    "For the Agent",
  ]);
  await db.conversationMember.update({
    where: { id: memberId({ userId: bob.id }) },
    data: { channelMuted: true },
  });
  await db.userPreference.upsert({
    where: { userId: bob.id },
    create: { userId: bob.id, browserNotificationsEnabled: true },
    update: { browserNotificationsEnabled: true },
  });
  const push = new PrismaWebPushSubscriptionStore(db);

  const created = await run(asAlice, {
    operation: "assign",
    number: first!.number,
    assignee: `@${bob.username}`,
  });
  const assigned = await run(asAlice, {
    operation: "assign",
    number: second!.number,
    assignee: `@${bob.username}`,
  });
  for (const [result, task] of [
    [created, created.tasks[0]!],
    [assigned, assigned.tasks[0]!],
  ] as const) {
    const receipt = result.assignmentReceipts![0]!;
    // The body is the same server-built text; the mention row is what reaches the muted assignee.
    expect(receipt.content).toEndWith(` to @${bob.username}`);
    const stored = await db.message.findUniqueOrThrow({
      where: { id: receipt.messageId },
      select: {
        body: true,
        threadRootId: true,
        mentions: { select: { kind: true, actorId: true, handle: true } },
        _count: { select: { deliveries: true } },
      },
    });
    expect(stored).toEqual({
      body: receipt.content,
      threadRootId: task.messageId,
      mentions: [{ kind: "user", actorId: bob.id, handle: bob.username }],
      _count: { deliveries: 0 },
    });
    expect(await push.notificationForRecipient(receipt.messageId, bob.id)).not.toBeNull();
  }

  // An Agent assignee's receipt keeps its one delivery and now reads as a personal mention, aimed
  // at the Task's thread, which the Agent now follows, and so does the Task's author, as a first
  // reply enrolls them.
  const forAgent = await run(asAlice, {
    operation: "assign",
    number: third!.number,
    assignee: `@${agent.name}`,
  });
  const agentReceipt = forAgent.assignmentReceipts![0]!;
  const agentTask = forAgent.tasks[0]!;
  const pending = await new PrismaDirectConversationRepository(db).readPendingAgentDeliveries(
    workspaceId,
    agent.id,
  );
  expect(pending.filter((delivery) => delivery.messageId === agentReceipt.messageId)).toEqual([
    expect.objectContaining({
      body: agentReceipt.content,
      target: `#${channel.channelName}:${agentTask.messageId}`,
      mentionsAgent: true,
    }),
  ]);
  expect(
    await db.threadFollow.findMany({
      where: { rootMessageId: agentTask.messageId! },
      select: { memberId: true },
      orderBy: { memberId: "asc" },
    }),
  ).toEqual(
    [memberId({ agentId: agent.id }), memberId({ userId: alice.id })]
      .sort()
      .map((id) => ({ memberId: id })),
  );
});
