import { test, expect } from "bun:test";
import { setup } from "./fixtures/task-dependencies";

/** Task relations are part of Tasks v2: a Workspace that has not switched it on behaves as it did without them. */

test("blockers, parents and --ready are refused where Tasks v2 is off", async () => {
  const { db, run, make, refusal } = await setup({ tasksV2: false });
  try {
    const [one, two] = await make("alice", 2);
    for (const command of [
      { operation: "create" as const, title: "x", blockedBy: [{ number: one! }] },
      { operation: "create" as const, title: "x", parent: { number: one! } },
      { operation: "amend" as const, number: two!, blockedBy: [{ number: one! }] },
      { operation: "amend" as const, number: two!, parent: null },
      { operation: "list" as const, ready: true },
    ]) {
      const error = await refusal(run("alice", command));
      expect(error.code).toBe("INVALID_INPUT");
      expect(error.errorId).toBe("task_relations_off");
      expect(error.hint).toContain("has not enabled");
    }
  } finally {
    await db.$disconnect();
  }
});

test("links already written are neither enforced, shown nor announced while it is off, and return when it is on", async () => {
  const { db, run, make, show, notices, finish, channel, one } = await setup({ tasksV2: false });
  try {
    const [blocker, waiting, parent, child] = await make("alice", 4);
    const common = { workspaceId: channel.workspaceId, conversationId: channel.id };
    const creator = await db.conversationMember.findFirstOrThrow({
      where: { conversationId: channel.id, userId: { not: null } },
      select: { id: true },
    });
    const ids = await db.task.findMany({
      where: { conversationId: channel.id, number: { in: [blocker!, waiting!, parent!, child!] } },
      select: { id: true, number: true },
    });
    const idOf = (number: number) => ids.find((task) => task.number === number)!.id;
    await db.taskDependency.create({
      data: {
        taskId: idOf(waiting!),
        blockedByTaskId: idOf(blocker!),
        creatorMemberId: creator.id,
        ...common,
      },
    });
    await db.taskParent.create({
      data: { taskId: idOf(child!), parentTaskId: idOf(parent!), ...common },
    });

    // Not shown.
    expect((await show(waiting!)).tasks[0]).toMatchObject({
      blockedBy: [],
      blocked: false,
      parent: null,
    });
    const shownBlocker = await show(blocker!);
    expect(shownBlocker.blocking).toBeUndefined();
    const shownParent = await show(parent!);
    expect(shownParent.subtree).toBeUndefined();
    expect(shownParent.tasks[0]!.subtasks).toBeNull();

    // Not enforced: a blocked task is claimed, and a parent with an open subtask goes to review.
    await run("alice", { operation: "assign", number: parent!, assignee: `agent:${one.id}` });
    await run("one", { operation: "claim", number: parent! });
    await run("one", { operation: "update", number: parent!, status: "in_review" });
    expect((await run("one", { operation: "claim", number: waiting! })).claims).toMatchObject([
      { success: true },
    ]);

    // Not announced: finishing the blocker tells no one.
    await finish("two", blocker!);
    expect((await notices(waiting!)).filter((n) => n.kind.startsWith("task.un"))).toEqual([]);

    // Switched on again, the links are back.
    await db.workspace.update({
      where: { id: channel.workspaceId },
      data: { experiments: { taskConversations: true } },
    });
    expect((await show(child!)).tasks[0]).toMatchObject({ parent: { number: parent } });
    expect((await show(parent!)).subtree).toMatchObject([{ number: child }]);
  } finally {
    await db.$disconnect();
  }
});
