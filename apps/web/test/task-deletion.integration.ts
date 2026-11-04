import { test, expect } from "bun:test";
import { DeletedTaskSweep } from "#src/server/tasks/deleted-task-sweep.server";
import { setup } from "./fixtures/task-dependencies";

// task #512: delete marks a Task for a minute before the sweep removes it; restoring in the
// window brings back the children and dependencies the marker never dropped.
test.skipIf(!Bun.env.TASK_TEST_DATABASE_URL && !Bun.env.DATABASE_URL)(
  "a deleted Task hides from the board and the list but keeps its row",
  async () => {
    const { db, run, make, channel } = await setup();
    const [one] = await make("alice", 1);
    await run("alice", { operation: "delete", number: one });

    const row = await db.task.findFirst({
      where: { conversationId: channel.id, number: one },
      select: { deletedAt: true },
    });
    expect(row?.deletedAt).not.toBeNull();

    const list = await run("alice", { operation: "list" });
    expect(list.tasks.map((task) => task.number)).not.toContain(one);
    await expect(run("alice", { operation: "show", number: one })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  },
);

test.skipIf(!Bun.env.TASK_TEST_DATABASE_URL && !Bun.env.DATABASE_URL)(
  "a Task restored inside the minute comes back whole: children and dependencies included",
  async () => {
    const { db, run, make, channel } = await setup();
    const [parent, blocker, waiting] = await make("alice", 3);
    await run("alice", {
      operation: "amend",
      number: waiting,
      parent: { number: parent },
      blockedBy: [{ number: blocker }],
    });
    await run("alice", { operation: "delete", number: parent });
    const historyBefore = await db.taskHistoryEvent.count({
      where: { task: { conversationId: channel.id, number: parent } },
    });
    await run("alice", { operation: "restore", number: parent });

    const restored = await run("alice", { operation: "show", number: parent });
    expect(restored.tasks[0]?.number).toBe(parent);
    const waitingRow = await db.task.findFirstOrThrow({
      where: { conversationId: channel.id, number: waiting },
      include: { parentLinks: true, dependencies: true },
    });
    expect(waitingRow.parentLinks.map((link) => link.parentTaskId)).toEqual([
      restored.tasks[0]?.id,
    ]);
    expect(waitingRow.dependencies.length).toBe(1);
    // Restoring writes no history and no channel record.
    const historyAfter = await db.taskHistoryEvent.count({
      where: { task: { conversationId: channel.id, number: parent } },
    });
    expect(historyAfter).toBe(historyBefore);
  },
);

test.skipIf(!Bun.env.TASK_TEST_DATABASE_URL && !Bun.env.DATABASE_URL)(
  "a Task restored after the minute, or by someone without delete authority, is refused",
  async () => {
    const { db, run, make, refusal, channel } = await setup();
    const [one] = await make("alice", 1);
    await run("alice", { operation: "delete", number: one });
    await db.task.update({
      where: {
        id: (await db.task.findFirstOrThrow({ where: { conversationId: channel.id, number: one } }))
          .id,
      },
      data: { deletedAt: new Date(Date.now() - 120_000) },
    });
    await refusal(run("alice", { operation: "restore", number: one }));

    const [two] = await make("alice", 1);
    await run("alice", { operation: "delete", number: two });
    await refusal(run("bob", { operation: "restore", number: two }));
  },
);

test.skipIf(!Bun.env.TASK_TEST_DATABASE_URL && !Bun.env.DATABASE_URL)(
  "the sweep hard-deletes: children go independent, the blocked unblock, the channel records it",
  async () => {
    const { db, run, make, channel } = await setup();
    // The shared test database holds markers from earlier runs; only this test's matter.
    await db.task.deleteMany({ where: { deletedAt: { not: null } } });
    const [parent, blocker, waiting] = await make("alice", 3);
    await run("alice", {
      operation: "amend",
      number: waiting,
      parent: { number: parent },
      blockedBy: [{ number: blocker }],
    });
    await run("alice", { operation: "delete", number: parent });
    await run("alice", { operation: "delete", number: blocker });
    await db.task.updateMany({
      where: { number: { in: [parent, blocker] } },
      data: { deletedAt: new Date(Date.now() - 120_000) },
    });

    await new DeletedTaskSweep(db).runOnce();

    const gone = await db.task.count({ where: { number: { in: [parent, blocker] } } });
    expect(gone).toBe(0);
    const waitingRow = await db.task.findFirstOrThrow({
      where: { conversationId: channel.id, number: waiting },
      include: { parentLinks: true, dependencies: true },
    });
    expect(waitingRow.parentLinks).toEqual([]);
    expect(waitingRow.dependencies).toEqual([]);
    const list = await run("alice", { operation: "list" });
    expect(list.tasks.map((task) => task.number)).toContain(waiting);
  },
);

test.skipIf(!Bun.env.TASK_TEST_DATABASE_URL && !Bun.env.DATABASE_URL)(
  "a Workspace admin deletes and edits a public-channel Task without joining; a member is refused in a private one",
  async () => {
    const { db: _db, run, make, admin, secret, refusal } = await setup();
    const [one] = await make("one", 1, {}, admin.id);
    // Alice owns the Workspace but never joined the channel: the public-board write is hers.
    await run("alice", { operation: "amend", number: one, title: `renamed-${one}` }, admin.id);
    await run("alice", { operation: "delete", number: one }, admin.id);

    const [two] = await make("alice", 1, {}, secret.id);
    await refusal(run("bob", { operation: "delete", number: two }, secret.id));
  },
);
