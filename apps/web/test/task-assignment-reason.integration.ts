import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { TaskBoard } from "#src/server/tasks/task-board.server";

test("an assignment's reason is stored on its notice, and a plain one carries none", async () => {
  const connectionString = Bun.env.TASK_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
  if (!connectionString)
    throw new Error("TASK_TEST_DATABASE_URL or DATABASE_URL must point to local PostgreSQL");

  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const board = new TaskBoard(db);
  const suffix = crypto.randomUUID();
  const short = suffix.slice(0, 8);
  const [owner, helper] = await Promise.all(
    ["owner", "helper"].map((name) =>
      db.user.create({
        data: { displayName: `tr-${name}-${short}`, username: `tr-${name}-${short}` },
      }),
    ),
  );
  const workspace = await db.workspace.create({
    data: {
      slug: `task-reason-${suffix}`,
      name: "Task reason",
      members: {
        create: [
          { userId: owner!.id, role: "owner" },
          { userId: helper!.id, role: "member" },
        ],
      },
    },
  });
  const channel = await db.conversation.create({
    data: {
      workspaceId: workspace.id,
      channelName: `reason-${short}`,
      members: { create: [{ userId: owner!.id }, { userId: helper!.id }] },
    },
  });
  const scope = { workspaceId: workspace.id, userId: owner!.id };

  try {
    const created = await board.execute(scope, {
      operation: "create",
      idempotencyKey: crypto.randomUUID(),
      conversationId: channel.id,
      title: "Hand over",
    });
    const number = created.tasks[0]!.number;

    // The handover sentence reaches the notice as its own param, never as rewritten body text.
    const withReason = await board.execute(scope, {
      operation: "assign",
      idempotencyKey: crypto.randomUUID(),
      conversationId: channel.id,
      number,
      assignee: `@${helper!.username}`,
      reason: "finish the daemon side first",
    });
    const receipt = withReason.assignmentReceipts?.[0]?.messageId;
    expect(receipt).toBeTruthy();
    const stored = await db.systemMessage.findUnique({ where: { messageId: receipt! } });
    expect(stored?.kind).toBe("task.assigned");
    expect(stored?.params).toMatchObject({ reason: "finish the daemon side first" });

    // An assignment nobody explained keeps the old params: no reason key at all.
    const plain = await board.execute(scope, {
      operation: "assign",
      idempotencyKey: crypto.randomUUID(),
      conversationId: channel.id,
      number,
      assignee: `@${owner!.username}`,
    });
    const plainReceipt = plain.assignmentReceipts?.[0]?.messageId;
    const plainStored = await db.systemMessage.findUnique({ where: { messageId: plainReceipt! } });
    expect(plainStored?.kind).toBe("task.assigned");
    expect(plainStored?.params).not.toHaveProperty("reason");
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } }).catch(() => undefined);
    await db.user.deleteMany({ where: { id: { in: [owner!.id, helper!.id] } } });
    await db.$disconnect();
  }
});
