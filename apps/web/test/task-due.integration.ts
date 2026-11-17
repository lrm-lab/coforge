import { expect, test } from "bun:test";
import { sweepDueTasks } from "#src/server/tasks/task-due-worker.server";
import { setup } from "./fixtures/task-dependencies";

/**
 * Task due dates (task #13) against real PostgreSQL: an optional instant set on create, changed
 * or cleared by `amend` (never `update`), read back with its `dueState`, ordered with priority
 * ahead of it and the earliest due first, recorded as `due_changed` history, and swept by the
 * 60s due-notification worker.
 */

test("a task takes a due instant on create, reads its state, and amend sets, keeps or clears it", async () => {
  const { db, run, make, show, refusal } = await setup();
  try {
    const hour = 60 * 60 * 1000;
    const soon = new Date(Date.now() + hour).toISOString();
    const later = new Date(Date.now() + 2 * hour).toISOString();
    const [task] = await make("bob", 1, { dueAt: soon });
    const created = (await show(task!)).tasks[0]!;
    expect(created.dueAt).toBe(soon);
    expect(created.dueHasTime).toBe(true);
    expect(created.dueState).toBe("due_soon");

    // Creation records the instant it opened with.
    const createdHistory = await run("bob", { operation: "history", number: task! });
    expect(
      createdHistory
        .history!.filter((event) => event.eventType === "due_changed")
        .map((event) => event.payload),
    ).toEqual([{ from: null, to: soon }]);

    // Amend moves it; history names both instants.
    await run("bob", { operation: "amend", number: task!, dueAt: later });
    const moved = (await show(task!)).tasks[0]!;
    expect(moved.dueAt).toBe(later);
    expect(moved.dueState).toBe("due_soon");

    // The same instant again — spelled differently, equal as a moment — writes no event.
    const sameInstant = later.replace("Z", "+00:00");
    await run("bob", { operation: "amend", number: task!, dueAt: sameInstant });
    const history = await run("bob", { operation: "history", number: task! });
    expect(
      history
        .history!.filter((event) => event.eventType === "due_changed")
        .map((event) => event.payload),
    ).toEqual([
      { from: null, to: soon },
      { from: soon, to: later },
    ]);

    // Null clears it; the read carries neither an instant nor a state.
    await run("bob", { operation: "amend", number: task!, dueAt: null });
    const cleared = (await show(task!)).tasks[0]!;
    expect(cleared.dueAt).toBeNull();
    expect(cleared.dueHasTime).toBe(false);
    expect(cleared.dueState).toBeNull();
    const clearedHistory = await run("bob", { operation: "history", number: task! });
    expect(
      clearedHistory
        .history!.filter((event) => event.eventType === "due_changed")
        .map((event) => event.payload),
    ).toEqual([
      { from: null, to: soon },
      { from: soon, to: later },
      { from: later, to: null },
    ]);

    // `update` never takes a due date, and neither does any other operation.
    expect(
      (
        await refusal(
          run("bob", {
            operation: "update",
            number: task!,
            status: "done",
            dueAt: soon,
          }),
        )
      ).code,
    ).toBe("INVALID_INPUT");
    expect(
      (await refusal(run("bob", { operation: "amend", number: task!, dueAt: "friday" }))).code,
    ).toBe("INVALID_INPUT");
    expect(
      (await refusal(run("bob", { operation: "amend", number: task!, dueAt: " " }))).code,
    ).toBe("INVALID_INPUT");
  } finally {
    await db.$disconnect();
  }
});

test("dueState reads overdue past the instant, soon within a day, and nothing further out", async () => {
  const { db, make, show } = await setup();
  try {
    const hour = 60 * 60 * 1000;
    const [overdue] = await make("bob", 1, {
      dueAt: new Date(Date.now() - hour).toISOString(),
    });
    const [soon] = await make("bob", 1, { dueAt: new Date(Date.now() + hour).toISOString() });
    const [later] = await make("bob", 1, {
      dueAt: new Date(Date.now() + 48 * hour).toISOString(),
    });
    const [plain] = await make("bob", 1);
    expect((await show(overdue!)).tasks[0]!.dueState).toBe("overdue");
    expect((await show(soon!)).tasks[0]!.dueState).toBe("due_soon");
    expect((await show(later!)).tasks[0]!.dueState).toBeNull();
    expect((await show(plain!)).tasks[0]!.dueState).toBeNull();
  } finally {
    await db.$disconnect();
  }
});

test("lists order by priority, then earliest due, undated last — the Agent queue too", async () => {
  const { db, board, principals, run, make } = await setup();
  try {
    const day = 24 * 60 * 60 * 1000;
    const at = (days: number) => new Date(Date.now() + days * day).toISOString();
    // Same level (none): the earliest due first, an undated Task behind every dated one.
    const [undated] = await make("alice", 1);
    const [inFive] = await make("alice", 1, { dueAt: at(5) });
    const [inTwo] = await make("alice", 1, { dueAt: at(2) });
    const [overdue] = await make("alice", 1, { dueAt: at(-1) });
    const listed = await run("alice", { operation: "list" });
    expect(listed.tasks.map((task) => task.number)).toEqual([overdue, inTwo, inFive, undated]);

    // A priority still outranks every due date: `low` sorts ahead of the undated `none` Tasks'
    // level even though they all carry earlier dues.
    await run("alice", { operation: "update", number: undated!, priority: "low" });
    const reprioritised = await run("alice", { operation: "list" });
    expect(reprioritised.tasks.map((task) => task.number)).toEqual([
      undated,
      overdue,
      inTwo,
      inFive,
    ]);
    await run("alice", { operation: "update", number: overdue!, priority: "urgent" });
    const urgentFirst = await run("alice", { operation: "list" });
    expect(urgentFirst.tasks.map((task) => task.number)).toEqual([overdue, undated, inTwo, inFive]);

    // The Agent's own queue (`list --mine`) shares the order.
    for (const number of [overdue, inTwo, inFive, undated])
      await run("one", { operation: "claim", number: number! });
    const mine = await board.execute(principals.one, {
      idempotencyKey: crypto.randomUUID(),
      operation: "list",
      mine: true,
    });
    expect(mine.tasks.map((task) => task.number)).toEqual([overdue, undated, inTwo, inFive]);
  } finally {
    await db.$disconnect();
  }
});

test("due worker notifies owner at dueAt, CCs creator from 2nd occurrence, skips done/closed, resets on amend, and queues for busy Agent", async () => {
  const { db, channel, principals, one, run, make } = await setup();
  try {
    const [alice, bob] = await Promise.all([
      db.user.findUniqueOrThrow({ where: { id: principals.alice.userId! } }),
      db.user.findUniqueOrThrow({ where: { id: principals.bob.userId! } }),
    ]);
    const DAY = 24 * 60 * 60 * 1000;
    const base = new Date("2026-11-10T12:00:00.000Z");
    const dueIso = base.toISOString();

    // 1. Owned by bob, created by alice -> occurrence 1 mentions bob only.
    const [ownedTaskNum] = await make("alice", 1, {
      dueAt: dueIso,
      dueHasTime: false,
      assignee: `@${bob.username}`,
    });
    // 2. Unassigned, created by alice -> falls back to creator alice.
    const [unassignedNum] = await make("alice", 1, { dueAt: dueIso });
    // 3. Done task -> never fires.
    const [doneNum] = await make("alice", 1, { dueAt: dueIso, assignee: `@${alice.username}` });
    await run("alice", { operation: "update", number: doneNum!, status: "done" });
    // 4. Owned by Agent `one` (simulating busy Agent receiving via AgentMessageDelivery).
    const [agentTaskNum] = await make("alice", 1, {
      dueAt: dueIso,
      assignee: `@${one.name}`,
    });

    const published: Array<{ channel: string; data: Uint8Array }> = [];
    const centrifugo = {
      async publish(ch: string, data: Uint8Array) {
        published.push({ channel: ch, data });
      },
      async publishBatch(
        items: readonly { channel: string; data: Uint8Array; skipHistory?: boolean }[],
      ): Promise<PromiseSettledResult<void>[]> {
        for (const item of items) published.push({ channel: item.channel, data: item.data });
        return items.map(() => ({ status: "fulfilled" as const, value: undefined }));
      },
    };

    const ownedTask = await db.task.findUniqueOrThrow({
      where: { conversationId_number: { conversationId: channel.id, number: ownedTaskNum! } },
    });
    const unassignedTask = await db.task.findUniqueOrThrow({
      where: { conversationId_number: { conversationId: channel.id, number: unassignedNum! } },
    });
    const doneTask = await db.task.findUniqueOrThrow({
      where: { conversationId_number: { conversationId: channel.id, number: doneNum! } },
    });
    const agentTask = await db.task.findUniqueOrThrow({
      where: { conversationId_number: { conversationId: channel.id, number: agentTaskNum! } },
    });

    // Sweep at dueAt -> occurrence 1 fires for ownedTask, unassignedTask, agentTask (not doneTask).
    const firstCount = await sweepDueTasks(db, centrifugo, base, ownedTask.workspaceId);
    expect(firstCount).toBe(3);

    // Repeating immediately before +24h does not fire again.
    expect(
      await sweepDueTasks(db, centrifugo, new Date(base.getTime() + 60_000), ownedTask.workspaceId),
    ).toBe(0);

    // Done task has no reminder rows.
    expect(await db.taskDueReminder.count({ where: { taskId: doneTask.id } })).toBe(0);

    // Owned task occurrence 1 mentioned ONLY bob, not alice.
    const ownedThread = (await db.task.findUniqueOrThrow({ where: { id: ownedTask.id } }))
      .discussionConversationId!;
    const occ1Msg = await db.message.findFirstOrThrow({
      where: { conversationId: ownedThread },
      orderBy: { sequence: "desc" },
      include: { mentions: true },
    });
    expect(occ1Msg.mentions.map((m) => m.actorId)).toEqual([bob.id]);

    // Unassigned task occurrence 1 mentioned creator alice.
    const unassignedThread = (await db.task.findUniqueOrThrow({ where: { id: unassignedTask.id } }))
      .discussionConversationId!;
    const unassignedMsg = await db.message.findFirstOrThrow({
      where: { conversationId: unassignedThread },
      orderBy: { sequence: "desc" },
      include: { mentions: true },
    });
    expect(unassignedMsg.mentions.map((m) => m.actorId)).toEqual([alice.id]);

    // Busy Agent `one` received an AgentMessageDelivery row (still pending while busy on its turn).
    const agentDeliveries = await db.agentMessageDelivery.findMany({
      where: { agentId: one.id, conversation: { kind: "task_thread" } },
      orderBy: { sequence: "desc" },
      include: { message: true },
    });
    expect(agentDeliveries.length).toBeGreaterThanOrEqual(2);
    const dueDelivery = agentDeliveries[0]!;
    expect(dueDelivery.receivedAt).toBeNull();
    expect(dueDelivery.message.body).toContain(`@${one.name}`);

    // Simulate Agent finishing its turn and acknowledging pending deliveries.
    await db.agentMessageDelivery.update({
      where: { deliveryId: dueDelivery.deliveryId },
      data: { receivedAt: new Date() },
    });
    expect(
      await db.agentMessageDelivery.count({
        where: {
          agentId: one.id,
          receivedAt: null,
          messageId: dueDelivery.messageId,
        },
      }),
    ).toBe(0);

    // At +50h (down for >2 days), catch-up sends ONLY occurrence 3 (not 2), and CCs creator alice on ownedTask.
    const plus50h = new Date(base.getTime() + 50 * 60 * 60 * 1000);
    expect(await sweepDueTasks(db, centrifugo, plus50h, ownedTask.workspaceId)).toBe(3);
    const ownedOcc3 = await db.message.findFirstOrThrow({
      where: { conversationId: ownedThread },
      orderBy: { sequence: "desc" },
      include: { mentions: true },
    });
    expect(ownedOcc3.body).toContain("Overdue reminder #3");
    expect(ownedOcc3.mentions.map((m) => m.actorId).sort()).toEqual([alice.id, bob.id].sort());
    expect(await db.taskDueReminder.count({ where: { taskId: ownedTask.id } })).toBe(2);

    // Amending dueAt (and even setting it back to the original dueIso) clears old task_due_reminders!
    const movedIso = new Date(base.getTime() + 7 * DAY).toISOString();
    await run("alice", { operation: "amend", number: ownedTaskNum!, dueAt: movedIso });
    expect(await db.taskDueReminder.count({ where: { taskId: ownedTask.id } })).toBe(0);
    await run("alice", { operation: "amend", number: ownedTaskNum!, dueAt: dueIso });
    expect(await sweepDueTasks(db, centrifugo, base, ownedTask.workspaceId)).toBe(1);

    void agentTask;
  } finally {
    await db.$disconnect();
  }
});
