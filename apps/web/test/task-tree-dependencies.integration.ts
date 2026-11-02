import { test, expect } from "bun:test";
import { setup } from "./fixtures/task-dependencies";

/** A Task may not wait for its own ancestor or descendant, whichever write creates the relation. */

test("a Task cannot become a sub-task of a Task it already waits for", async () => {
  const { db, run, make, refusal, channel } = await setup();
  try {
    const [blocker] = await make("alice", 1);
    const [waiting] = await make("alice", 1, { blockedBy: [{ number: blocker! }] });
    const refused = await refusal(
      run("alice", { operation: "amend", number: waiting!, parent: { number: blocker! } }),
    );
    expect(refused.code).toBe("INVALID_INPUT");
    expect(refused.errorId).toBe("task_relation_invalid");
    expect(refused.hint).toContain("ancestor");
    // The change wrote nothing.
    const task = await db.task.findFirstOrThrow({
      where: { conversationId: channel.id, number: waiting! },
      select: { id: true },
    });
    expect(await db.taskParent.findUnique({ where: { taskId: task.id } })).toBeNull();
  } finally {
    await db.$disconnect();
  }
});

test("a parent and a blocker set together are judged on the tree they produce", async () => {
  const { db, run, make, refusal, channel } = await setup();
  try {
    const [grandparent] = await make("alice", 1);
    const [parent] = await make("alice", 1, { parent: { number: grandparent! } });
    const [task] = await make("alice", 1);
    // Grandparent is not an ancestor of `task` in the tree the command read; it is after the
    // parent change the same command makes, which is what the check judges.
    const refused = await refusal(
      run("alice", {
        operation: "amend",
        number: task!,
        parent: { number: parent! },
        blockedBy: [{ number: grandparent! }],
      }),
    );
    expect(refused.code).toBe("INVALID_INPUT");
    expect(refused.hint).toContain("ancestor");
    const row = await db.task.findFirstOrThrow({
      where: { conversationId: channel.id, number: task! },
      select: { parentLinks: true, dependencies: true },
    });
    expect(row.parentLinks).toEqual([]);
    expect(row.dependencies).toEqual([]);
  } finally {
    await db.$disconnect();
  }
});

test("a Task may wait for its former parent once it is detached", async () => {
  const { db, run, make, channel } = await setup();
  try {
    const [parent] = await make("alice", 1);
    const [child] = await make("alice", 1, { parent: { number: parent! } });
    // The write removes the parent link the tree check read, so it is judged on the tree it
    // produces: the child has no ancestor and may wait for the old parent.
    const amended = await run("alice", {
      operation: "amend",
      number: child!,
      parent: null,
      blockedBy: [{ number: parent! }],
    });
    expect(amended.tasks[0]!.parent).toBeNull();
    expect(amended.tasks[0]!.blockedBy).toMatchObject([{ number: parent }]);
    const row = await db.task.findFirstOrThrow({
      where: { conversationId: channel.id, number: child! },
      select: { parentLinks: true, dependencies: true },
    });
    expect(row.parentLinks).toEqual([]);
    expect(row.dependencies).toHaveLength(1);
  } finally {
    await db.$disconnect();
  }
});

test("a new parent that already waits for the moved sub-task is refused", async () => {
  const { db, run, make, refusal } = await setup();
  try {
    const [blocker] = await make("alice", 1);
    const [waiting] = await make("alice", 1, { blockedBy: [{ number: blocker! }] });
    // The other direction: the new parent would wait for its own sub-task.
    const refused = await refusal(
      run("alice", { operation: "amend", number: blocker!, parent: { number: waiting! } }),
    );
    expect(refused.code).toBe("INVALID_INPUT");
    expect(refused.hint).toContain("descendant");
  } finally {
    await db.$disconnect();
  }
});

test("creating a sub-task that waits for its parent or an ancestor is refused", async () => {
  const { db, run, make, refusal, channel } = await setup();
  try {
    const [grandparent] = await make("alice", 1);
    const [parent] = await make("alice", 1, { parent: { number: grandparent! } });
    for (const number of [parent, grandparent]) {
      const refused = await refusal(
        run("alice", {
          operation: "create",
          titles: ["child"],
          parent: { number: parent! },
          blockedBy: [{ number: number! }],
        }),
      );
      expect(refused.code).toBe("INVALID_INPUT");
      expect(refused.hint).toContain("ancestor");
    }
    expect(await db.task.count({ where: { conversationId: channel.id, title: "child" } })).toBe(0);
  } finally {
    await db.$disconnect();
  }
});
