import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { TaskBoard } from "#src/server/tasks/task-board.server";

test("TaskBoard limits other-person assignment to Workspace managers and enforces revision", async () => {
  const connectionString = Bun.env.TASK_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
  if (!connectionString)
    throw new Error("TASK_TEST_DATABASE_URL or DATABASE_URL must point to local PostgreSQL");

  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const board = new TaskBoard(db);
  const suffix = crypto.randomUUID();
  const short = suffix.slice(0, 8);
  const [alice, bob, carol] = await Promise.all(
    ["alice", "bob", "carol"].map((name) =>
      db.user.create({
        data: { displayName: `tu-${name}-${short}`, username: `tu-${name}-${short}` },
      }),
    ),
  );
  const workspace = await db.workspace.create({
    data: {
      slug: `task-unassign-${suffix}`,
      name: "Task unassign",
      members: {
        create: [{ userId: alice!.id, role: "owner" }, { userId: bob!.id }, { userId: carol!.id }],
      },
    },
  });
  const channel = await db.conversation.create({
    data: {
      workspaceId: workspace.id,
      channelName: `unassign-${short}`,
      members: { create: [{ userId: alice!.id }, { userId: bob!.id }, { userId: carol!.id }] },
    },
  });

  try {
    const createdA = await board.execute(
      { workspaceId: workspace.id, userId: alice!.id },
      {
        operation: "create",
        idempotencyKey: crypto.randomUUID(),
        conversationId: channel.id,
        title: "Task A",
      },
    );
    const taskANumber = createdA.tasks[0]!.number;
    const bobAssigned = await board.execute(
      { workspaceId: workspace.id, userId: bob!.id },
      {
        operation: "assign",
        idempotencyKey: crypto.randomUUID(),
        conversationId: channel.id,
        number: taskANumber,
        assignee: `@${bob!.username}`,
      },
    );
    expect(bobAssigned.tasks[0]!.owner?.memberId).toBeDefined();

    // A stale expectedRevision is a CONFLICT even for the owner.
    await expect(
      board.execute(
        { workspaceId: workspace.id, userId: bob!.id },
        {
          operation: "unassign",
          idempotencyKey: crypto.randomUUID(),
          conversationId: channel.id,
          number: taskANumber,
          expectedRevision: bobAssigned.tasks[0]!.revision + 1,
        },
      ),
    ).rejects.toThrow("CONFLICT");

    // The owner may unassign their own task.
    const unassigned = await board.execute(
      { workspaceId: workspace.id, userId: bob!.id },
      {
        operation: "unassign",
        idempotencyKey: crypto.randomUUID(),
        conversationId: channel.id,
        number: taskANumber,
        expectedRevision: bobAssigned.tasks[0]!.revision,
      },
    );
    expect(unassigned.tasks[0]!.owner).toBeNull();

    // Unassigning an already-unowned Task is a no-op, not an error.
    const noop = await board.execute(
      { workspaceId: workspace.id, userId: carol!.id },
      {
        operation: "unassign",
        idempotencyKey: crypto.randomUUID(),
        conversationId: channel.id,
        number: taskANumber,
      },
    );
    expect(noop.tasks[0]!.owner).toBeNull();
    expect(noop.tasks[0]!.revision).toBe(unassigned.tasks[0]!.revision);

    // Only a Workspace manager may clear or reassign another member's Task.
    const createdB = await board.execute(
      { workspaceId: workspace.id, userId: alice!.id },
      {
        operation: "create",
        idempotencyKey: crypto.randomUUID(),
        conversationId: channel.id,
        title: "Task B",
      },
    );
    const taskBNumber = createdB.tasks[0]!.number;
    await board.execute(
      { workspaceId: workspace.id, userId: carol!.id },
      {
        operation: "assign",
        idempotencyKey: crypto.randomUUID(),
        conversationId: channel.id,
        number: taskBNumber,
        assignee: `@${carol!.username}`,
      },
    );
    await expect(
      board.execute(
        { workspaceId: workspace.id, userId: bob!.id },
        {
          operation: "unassign",
          idempotencyKey: crypto.randomUUID(),
          conversationId: channel.id,
          number: taskBNumber,
        },
      ),
    ).rejects.toThrow("ACCESS_DENIED");
    await expect(
      board.execute(
        { workspaceId: workspace.id, userId: bob!.id },
        {
          operation: "assign",
          idempotencyKey: crypto.randomUUID(),
          conversationId: channel.id,
          number: taskBNumber,
          assignee: `@${alice!.username}`,
        },
      ),
    ).rejects.toThrow("ACCESS_DENIED");
    await expect(
      board.execute(
        { workspaceId: workspace.id, userId: bob!.id },
        {
          operation: "create",
          idempotencyKey: crypto.randomUUID(),
          conversationId: channel.id,
          title: "No member reservation",
          assignee: `@${carol!.username}`,
        },
      ),
    ).rejects.toThrow("ACCESS_DENIED");
    const memberUnassigned = await board.execute(
      { workspaceId: workspace.id, userId: alice!.id },
      {
        operation: "unassign",
        idempotencyKey: crypto.randomUUID(),
        conversationId: channel.id,
        number: taskBNumber,
      },
    );
    expect(memberUnassigned.tasks[0]!.owner).toBeNull();
    const memberReassigned = await board.execute(
      { workspaceId: workspace.id, userId: alice!.id },
      {
        operation: "assign",
        idempotencyKey: crypto.randomUUID(),
        conversationId: channel.id,
        number: taskBNumber,
        assignee: `@${alice!.username}`,
      },
    );
    expect(memberReassigned.tasks[0]!.owner?.handle).toBe(alice!.username);
    // Reserved creation for someone else uses the same Workspace manager rule.
    const createdForCarol = await board.execute(
      { workspaceId: workspace.id, userId: alice!.id },
      {
        operation: "create",
        idempotencyKey: crypto.randomUUID(),
        conversationId: channel.id,
        title: "Task C",
        assignee: `@${carol!.username}`,
      },
    );
    expect(createdForCarol.tasks[0]!.owner?.handle).toBe(carol!.username);
    // Deleting a Task someone else created still needs a Workspace owner or admin.
    await expect(
      board.execute(
        { workspaceId: workspace.id, userId: bob!.id },
        {
          operation: "delete",
          idempotencyKey: crypto.randomUUID(),
          conversationId: channel.id,
          number: taskBNumber,
        },
      ),
    ).rejects.toThrow("ACCESS_DENIED");
    // Someone who left the channel is no longer a member, so they cannot take a Task off anyone.
    await db.conversationMember.updateMany({
      where: { conversationId: channel.id, userId: carol!.id },
      data: { leftAt: new Date() },
    });
    await expect(
      board.execute(
        { workspaceId: workspace.id, userId: carol!.id },
        {
          operation: "unassign",
          idempotencyKey: crypto.randomUUID(),
          conversationId: channel.id,
          number: taskBNumber,
        },
      ),
    ).rejects.toThrow("ACCESS_DENIED");
  } finally {
    await db.workspace.deleteMany({ where: { id: workspace.id } });
    await db.user.deleteMany({ where: { id: { in: [alice!.id, bob!.id, carol!.id] } } });
    await db.$disconnect();
  }
});
