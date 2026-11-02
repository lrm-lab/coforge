import { test, expect } from "bun:test";
import { setup } from "./fixtures/task-dependencies";

/** The notices that tell a task's owner when its blockers or subtasks change, against real PostgreSQL. */

test("a started task that gains an unfinished blocker tells its owner, and only its owner", async () => {
  const { db, run, make, notices, one } = await setup();
  try {
    const [owned, idle, own, blocker] = await make("alice", 4);
    await run("one", { operation: "claim", number: owned! });
    await run("one", { operation: "claim", number: own! });
    await run("alice", {
      operation: "amend",
      number: owned!,
      blockedBy: [{ number: blocker! }],
    });
    await run("alice", {
      operation: "amend",
      number: idle!,
      blockedBy: [{ number: blocker! }],
    });
    // Amended by the owner itself, nobody needs telling.
    await run("one", {
      operation: "amend",
      number: own!,
      blockedBy: [{ number: blocker! }],
    });
    const blocked = async (number: number) =>
      (await notices(number)).filter((notice) => notice.kind === "task.blocked");
    expect(await blocked(owned!)).toEqual([{ kind: "task.blocked", agents: [one.id] }]);
    expect(await blocked(idle!)).toEqual([]);
    expect(await blocked(own!)).toEqual([]);
  } finally {
    await db.$disconnect();
  }
});

test("a parent cannot go to review while a subtask is open, and its owner is told when the last one finishes", async () => {
  const { db, run, make, notices, finish, refusal, one } = await setup();
  try {
    const [parent] = await make("alice", 1);
    const [first, second] = await make("alice", 2, { parent: { number: parent! } });
    await run("alice", {
      operation: "assign",
      number: parent!,
      assignee: `agent:${one.id}`,
    });
    await run("one", { operation: "claim", number: parent! });
    const early = await refusal(
      run("one", { operation: "update", number: parent!, status: "in_review" }),
    );
    expect(early.code).toBe("CONFLICT");
    expect(early.errorId).toBe("task_subtasks_open");
    expect(early.hint).toContain(`#${first}`);
    expect(early.hint).toContain(`#${second}`);
    // A manager moves it regardless, and back.
    await run("alice", {
      operation: "update",
      number: parent!,
      status: "in_review",
    });
    await run("alice", {
      operation: "update",
      number: parent!,
      status: "in_progress",
    });

    const finished = async () =>
      (await notices(parent!)).filter((notice) => notice.kind === "task.subtasks_finished");
    await finish("two", first!);
    expect(await finished()).toEqual([]);
    await finish("two", second!);
    expect(await finished()).toEqual([{ kind: "task.subtasks_finished", agents: [one.id] }]);
    await run("one", {
      operation: "update",
      number: parent!,
      status: "in_review",
    });
  } finally {
    await db.$disconnect();
  }
});

test("reopening a finished blocker tells the owners of the started tasks that wait for it", async () => {
  const { db, run, make, notices, finish, one } = await setup();
  try {
    const [blocker] = await make("alice", 1);
    const [started, idle] = await make("alice", 2, { blockedBy: [{ number: blocker! }] });
    await finish("two", blocker!);
    await run("one", { operation: "claim", number: started! });
    await run("alice", { operation: "assign", number: idle!, assignee: `agent:${one.id}` });
    await run("alice", { operation: "update", number: blocker!, status: "todo" });
    const blocked = async (number: number) =>
      (await notices(number)).filter((notice) => notice.kind === "task.blocked");
    expect(await blocked(started!)).toEqual([{ kind: "task.blocked", agents: [one.id] }]);
    expect(await blocked(idle!)).toEqual([]);
  } finally {
    await db.$disconnect();
  }
});

test("a blocker that goes away without finishing releases an owned task, unless its owner did it", async () => {
  const { db, run, make, notices, one } = await setup();
  try {
    const [removed, byOwner, nobody, deleted, stillBlocked, other] = await make("alice", 6);
    const waiting = await make("alice", 4);
    const [amendedByManager, amendedByOwner, unowned, deletedBlocker] = waiting;
    // Each waits for one open blocker; `deletedBlocker` is the one that is deleted below.
    await run("alice", {
      operation: "amend",
      number: amendedByManager!,
      blockedBy: [{ number: removed! }],
    });
    await run("alice", {
      operation: "amend",
      number: amendedByOwner!,
      blockedBy: [{ number: byOwner! }],
    });
    await run("alice", { operation: "amend", number: unowned!, blockedBy: [{ number: nobody! }] });
    await run("alice", {
      operation: "amend",
      number: deletedBlocker!,
      blockedBy: [{ number: deleted! }],
    });
    for (const number of [amendedByManager!, amendedByOwner!, deletedBlocker!])
      await run("alice", { operation: "assign", number, assignee: `agent:${one.id}` });
    // Waits for two: deleting one of them frees nothing.
    await run("alice", {
      operation: "amend",
      number: stillBlocked!,
      blockedBy: [{ number: deleted! }, { number: other! }],
    });
    await run("alice", { operation: "assign", number: stillBlocked!, assignee: `agent:${one.id}` });

    await run("alice", { operation: "amend", number: amendedByManager!, blockedBy: [] });
    await run("one", { operation: "amend", number: amendedByOwner!, blockedBy: [] });
    await run("alice", { operation: "amend", number: unowned!, blockedBy: [] });
    await run("alice", { operation: "delete", number: deleted! });

    const released = async (number: number) =>
      (await notices(number)).filter((notice) => notice.kind === "task.released");
    expect(await released(amendedByManager!)).toEqual([
      { kind: "task.released", agents: [one.id] },
    ]);
    expect(await released(deletedBlocker!)).toEqual([{ kind: "task.released", agents: [one.id] }]);
    expect(await released(amendedByOwner!)).toEqual([]);
    expect(await released(unowned!)).toEqual([]);
    expect(await released(stillBlocked!)).toEqual([]);
  } finally {
    await db.$disconnect();
  }
});

test("a task nobody holds, or whose owner caused the change, is told nothing", async () => {
  const { db, run, make, notices, finish, one } = await setup();
  try {
    const [blocker, unowned, byOwner, ownBlocker] = await make("alice", 4);
    await run("alice", { operation: "amend", number: unowned!, blockedBy: [{ number: blocker! }] });
    await run("alice", {
      operation: "amend",
      number: byOwner!,
      blockedBy: [{ number: ownBlocker! }],
    });
    await run("alice", { operation: "assign", number: byOwner!, assignee: `agent:${one.id}` });
    await finish("two", blocker!);
    // The owner of the waiting task finishes its blocker itself.
    await finish("one", ownBlocker!);
    const kinds = async (number: number) => (await notices(number)).map((notice) => notice.kind);
    expect(await kinds(unowned!)).not.toContain("task.unblocked");
    expect(await kinds(byOwner!)).not.toContain("task.unblocked");

    const [parent, ownerless, ownedChild] = await make("alice", 3);
    await run("alice", { operation: "amend", number: ownerless!, parent: { number: parent! } });
    await run("alice", { operation: "amend", number: ownedChild!, parent: { number: parent! } });
    await finish("two", ownerless!);
    await finish("two", ownedChild!);
    // No owner on the parent: { number: nobody } to tell.
    expect(await kinds(parent!)).not.toContain("task.subtasks_finished");
    // The parent's owner finishes the last subtask itself.
    const [ownedParent, lastChild] = await make("alice", 2);
    await run("alice", { operation: "assign", number: ownedParent!, assignee: `agent:${one.id}` });
    await run("alice", {
      operation: "amend",
      number: lastChild!,
      parent: { number: ownedParent! },
    });
    await finish("one", lastChild!);
    expect(await kinds(ownedParent!)).not.toContain("task.subtasks_finished");
  } finally {
    await db.$disconnect();
  }
});

test("removing a blocker from a task that already finished tells nobody", async () => {
  const { db, run, make, notices, one } = await setup();
  try {
    const [blocker, forced] = await make("alice", 2);
    await run("alice", { operation: "amend", number: forced!, blockedBy: [{ number: blocker! }] });
    await run("alice", { operation: "assign", number: forced!, assignee: `agent:${one.id}` });
    // A manager may finish a task that still waits.
    await run("alice", { operation: "update", number: forced!, status: "done" });
    await run("alice", { operation: "amend", number: forced!, blockedBy: [] });
    expect((await notices(forced!)).map((notice) => notice.kind)).not.toContain("task.released");
  } finally {
    await db.$disconnect();
  }
});

test("deleting the last open subtask tells the parent's owner; an earlier one does not", async () => {
  const { db, run, make, notices, one } = await setup();
  try {
    const [parent] = await make("alice", 1);
    await run("alice", { operation: "assign", number: parent!, assignee: `agent:${one.id}` });
    const [first, second] = await make("alice", 2, { parent: { number: parent! } });
    const finished = async () =>
      (await notices(parent!)).filter((notice) => notice.kind === "task.subtasks_finished");
    await run("alice", { operation: "delete", number: first! });
    expect(await finished()).toEqual([]);
    await run("alice", { operation: "delete", number: second! });
    expect(await finished()).toEqual([{ kind: "task.subtasks_finished", agents: [one.id] }]);
  } finally {
    await db.$disconnect();
  }
});

test("a notice to an owner who has left is posted without a mention or a delivery", async () => {
  const { db, run, make, finish, channel, one } = await setup();
  try {
    const [blocker] = await make("alice", 1);
    const [waiting] = await make("alice", 1, { blockedBy: [{ number: blocker! }] });
    await run("alice", { operation: "assign", number: waiting!, assignee: `agent:${one.id}` });
    await db.conversationMember.updateMany({
      where: { conversationId: channel.id, agentId: one.id },
      data: { leftAt: new Date() },
    });
    await finish("two", blocker!);
    const task = await db.task.findFirstOrThrow({
      where: { conversationId: channel.id, number: waiting! },
      select: { messageId: true, discussionConversationId: true },
    });
    const notice = await db.message.findFirstOrThrow({
      where: {
        ...(task.messageId
          ? { threadRootId: task.messageId }
          : { conversationId: task.discussionConversationId! }),
        systemMessage: { kind: "task.unblocked" },
      },
      select: { mentions: true, deliveries: true },
    });
    expect(notice.mentions).toEqual([]);
    expect(notice.deliveries).toEqual([]);
  } finally {
    await db.$disconnect();
  }
});
