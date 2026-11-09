import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import type { TaskCommand, TaskPrincipal, TaskView } from "@lrm/coforge-sdk/internal";
import { PrismaClient } from "#src/generated/prisma/client";
import { TaskBoard } from "#src/server/tasks/task-board.server";
import { Labels } from "#src/server/tasks/labels.server";

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

test("An Agent's own Task list covers its channels and DMs and says what it leaves out", async () => {
  const connectionString = Bun.env.TASK_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
  if (!connectionString)
    throw new Error("TASK_TEST_DATABASE_URL or DATABASE_URL must point to local PostgreSQL");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const handle = crypto.randomUUID().slice(0, 8);
  const alice = await db.user.create({
    data: { displayName: `list-alice-${handle}`, username: `list-alice-${handle}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `task-list-${handle}`,
      name: "Task list",
      members: { create: [{ userId: alice.id, role: "owner" }] },
      agents: {
        create: {
          name: `list-agent-${handle}`,
          displayName: "List Agent",
          ownerId: alice.id,
          runtimeConfig: {},
        },
      },
    },
    include: { agents: true },
  });
  const agent = workspace.agents[0]!;
  const channel = (name: string) =>
    db.conversation.create({
      data: {
        workspaceId: workspace.id,
        channelName: `${name}-${handle}`,
        members: { create: [{ userId: alice.id }, { agentId: agent.id }] },
      },
    });
  const work = await channel("work");
  const archived = await channel("old");
  const hidden = await channel("hidden");
  const left = await channel("left");
  await db.conversation.create({
    data: {
      workspaceId: workspace.id,
      directKey: [alice.id, agent.id].sort().join(":"),
      members: { create: [{ userId: alice.id }, { agentId: agent.id }] },
    },
  });
  const board = new TaskBoard(db);
  const asAlice: TaskPrincipal = { workspaceId: workspace.id, userId: alice.id };
  const asAgent: TaskPrincipal = { workspaceId: workspace.id, agentId: agent.id };
  const run = (principal: TaskPrincipal, command: Omit<TaskCommand, "idempotencyKey">) =>
    board.execute(principal, { idempotencyKey: crypto.randomUUID(), ...command });
  const selfAssigned = async (target: string, title: string) =>
    (await run(asAgent, { operation: "create", target, title, assignee: `@${agent.name}` }))
      .tasks[0]!;
  const summary = (task: TaskView) => ({
    channelRef: task.channelRef,
    number: task.number,
    status: task.status,
    creator: task.creator.handle,
  });

  try {
    const reservedResult = await run(asAlice, {
      operation: "create",
      conversationId: work.id,
      title: "Reserved for the Agent",
      assignee: `@${agent.name}`,
    });
    const reserved = reservedResult.tasks[0]!;
    // A person's assignment of an Agent is a direct instruction: "do it first", never a number.
    expect(reservedResult.assignmentReceipts![0]!.content).toBe(
      `📌 ${alice.displayName ?? alice.username} assigned #${reserved.number} "Reserved for the Agent" to @${agent.name} — do it first`,
    );
    const unassignedTask = (
      await run(asAlice, { operation: "create", conversationId: work.id, title: "Unassigned" })
    ).tasks[0]!;
    const startedResult = await run(asAgent, {
      operation: "create",
      target: `#${work.channelName}`,
      title: "Started by the Agent",
      assignee: `@${agent.name}`,
    });
    const started = startedResult.tasks[0]!;
    // An Agent's own assignment names its queue place and what is immediately ahead (task #716).
    expect(startedResult.assignmentReceipts![0]!.content).toBe(
      `📌 ${agent.displayName ?? agent.name} assigned #${started.number} "Started by the Agent" to @${agent.name} — queue #2 (ahead: #${reserved.number})`,
    );
    const finished = await selfAssigned(`#${work.channelName}`, "Finished");
    // A Task moves forward through the board, so Done is reached through In Review.
    for (const status of ["in_progress", "in_review", "done"] as const)
      await run(asAgent, {
        operation: "update",
        target: `#${work.channelName}`,
        number: finished.number,
        status,
      });
    const inDirectResult = await run(asAgent, {
      operation: "create",
      target: `@${alice.username}`,
      title: "Direct work",
      assignee: `@${agent.name}`,
    });
    const inDirect = inDirectResult.tasks[0]!;
    // Ahead Tasks in another conversation are named by their channel (task #716).
    expect(inDirectResult.assignmentReceipts![0]!.content).toBe(
      `📌 ${agent.displayName ?? agent.name} assigned #${inDirect.number} "Direct work" to @${agent.name} — queue #3 (ahead: #${work.channelName}:#${reserved.number}, #${work.channelName}:#${started.number})`,
    );
    const inArchived = await selfAssigned(`#${archived.channelName}`, "Archived work");
    await selfAssigned(`#${hidden.channelName}`, "Hidden work");
    await selfAssigned(`#${left.channelName}`, "Work in a channel the Agent left");
    await db.conversation.update({ where: { id: archived.id }, data: { archivedAt: new Date() } });
    await db.conversation.update({
      where: { id: hidden.id },
      data: { hiddenFromWorkspaceAt: new Date() },
    });
    await db.conversationMember.updateMany({
      where: { conversationId: left.id, agentId: agent.id },
      data: { leftAt: new Date() },
    });

    const mine = await run(asAgent, { operation: "list", mine: true });
    expect(
      mine.tasks.map(summary).sort((a, b) => a.channelRef!.localeCompare(b.channelRef!)),
    ).toEqual(
      [
        {
          channelRef: `#${archived.channelName}`,
          number: inArchived.number,
          status: "in_progress" as const,
          creator: agent.name,
        },
        {
          channelRef: `#${work.channelName}`,
          number: reserved.number,
          status: "todo" as const,
          creator: alice.username,
        },
        {
          channelRef: `#${work.channelName}`,
          number: started.number,
          status: "in_progress" as const,
          creator: agent.name,
        },
        {
          channelRef: `@${alice.username}`,
          number: inDirect.number,
          status: "in_progress" as const,
          creator: agent.name,
        },
      ].sort((a, b) => a.channelRef.localeCompare(b.channelRef) || a.number - b.number),
    );
    for (const task of mine.tasks) {
      expect(task.createdAt).toMatch(ISO);
      expect(task.updatedAt).toMatch(ISO);
      expect(Date.parse(task.updatedAt)).toBeGreaterThanOrEqual(Date.parse(task.createdAt));
    }
    // The list is complete for what the query reads; it asserts nothing about conversations the
    // Agent is not in or that are hidden from the Workspace.
    expect(mine.coverage).toEqual({
      status: "incomplete",
      visibleConversationKinds: ["channel", "dm"],
      includesArchived: true,
      inaccessibleScope: "not_asserted",
      reason: expect.stringContaining("member"),
    });
    expect(mine.pagination).toEqual({ mode: "complete", truncated: false });
    // The queue numbers every unfinished own Task in the covered scope — the archived channel
    // included, the hidden and left ones excluded — in work order (task #716).
    expect(mine.queue!.map((entry) => entry.taskId)).toEqual([
      reserved.id,
      started.id,
      inDirect.id,
      inArchived.id,
    ]);
    expect(mine.tasks.map((task) => task.id)).toEqual(mine.queue!.map((entry) => entry.taskId));

    const all = await run(asAgent, { operation: "list", mine: true, status: "all" });
    expect(all.tasks.map((task) => task.number)).toContain(finished.number);
    expect(all.tasks).toHaveLength(5);
    // "all" widens the rows to finished Tasks; the queue still counts only the unfinished set.
    expect(all.queue).toEqual(mine.queue);
    // Task #506: several statuses at once keep exactly those.
    const picked = await run(asAgent, {
      operation: "list",
      mine: true,
      statuses: ["in_progress", "done"],
    });
    expect(new Set(picked.tasks.map((task) => task.status))).toEqual(
      new Set(["in_progress", "done"]),
    );
    expect(picked.tasks.map((task) => task.number)).toContain(finished.number);
    expect(picked.tasks.map((task) => task.number)).toContain(started.number);
    // A filtered list keeps each row's place in the whole queue: In Progress and Done shown
    // together still number from the full set, and a finished Task has no place at all.
    const pickedPositions = new Map(
      picked.queue!.map((entry) => [entry.taskId, entry.position] as const),
    );
    expect(picked.tasks.map((task) => pickedPositions.get(task.id) ?? null)).toEqual([
      2,
      null,
      3,
      4,
    ]);
    const done = await run(asAgent, { operation: "list", mine: true, status: "done" });
    expect(done.tasks.map(summary)).toEqual([
      {
        channelRef: `#${work.channelName}`,
        number: finished.number,
        status: "done",
        creator: agent.name,
      },
    ]);
    // The queue still counts the whole unfinished set behind a filtered list.
    expect(done.queue).toHaveLength(4);
    expect(done.queue!.some((entry) => entry.taskId === finished.id)).toBe(false);

    // A label filter narrows the rows the same way: the labeled Task keeps its place in the
    // whole queue, not a renumbered one (task #716).
    await new Labels(db).create(workspace.id, alice.id, { name: "queued" });
    await run(asAlice, {
      operation: "amend",
      conversationId: work.id,
      number: started.number,
      labels: ["queued"],
    });
    const labeled = await run(asAgent, { operation: "list", mine: true, labels: ["queued"] });
    expect(labeled.tasks.map((task) => task.number)).toEqual([started.number]);
    expect(labeled.queue).toHaveLength(4);
    expect(labeled.queue!.find((entry) => entry.taskId === started.id)!.position).toBe(2);

    // `assign` carries the same note `create --assignee` does: a person's is "do it first",
    // an Agent's its queue place (task #716).
    const humanAssigned = await run(asAlice, {
      operation: "assign",
      conversationId: work.id,
      number: unassignedTask.number,
      assignee: `@${agent.name}`,
    });
    expect(humanAssigned.assignmentReceipts![0]!.content).toBe(
      `📌 ${alice.displayName ?? alice.username} assigned #${unassignedTask.number} "Unassigned" to @${agent.name} — do it first`,
    );
    const pick = (
      await run(asAlice, { operation: "create", conversationId: work.id, title: "Agent pick" })
    ).tasks[0]!;
    const agentAssigned = await run(asAgent, {
      operation: "assign",
      target: `#${work.channelName}`,
      number: pick.number,
      assignee: `@${agent.name}`,
    });
    expect(agentAssigned.assignmentReceipts![0]!.content).toBe(
      `📌 ${agent.displayName ?? agent.name} assigned #${pick.number} "Agent pick" to @${agent.name} — queue #6 (ahead: #${started.number}, a task in another channel, #${archived.channelName}:#${inArchived.number})`,
    );

    // A conversation's board names each Task's creator, marks one who has left, and carries the
    // Task's timestamps; only the Agent's own list describes its coverage.
    await db.conversationMember.updateMany({
      where: { conversationId: work.id, userId: alice.id },
      data: { leftAt: new Date() },
    });
    const boardList = await run(asAgent, { operation: "list", target: `#${work.channelName}` });
    expect(
      boardList.tasks.map((task) => ({
        number: task.number,
        creator: task.creator.handle,
        left: task.creator.left,
      })),
    ).toEqual([
      { number: reserved.number, creator: alice.username, left: true },
      { number: reserved.number + 1, creator: alice.username, left: true },
      { number: started.number, creator: agent.name, left: undefined },
      { number: finished.number, creator: agent.name, left: undefined },
      { number: pick.number, creator: alice.username, left: true },
    ]);
    expect(boardList.tasks[0]!.createdAt).toMatch(ISO);
    expect(boardList.coverage).toBeUndefined();
    expect(boardList.pagination).toBeUndefined();
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.delete({ where: { id: alice.id } });
    await db.$disconnect();
  }
});
