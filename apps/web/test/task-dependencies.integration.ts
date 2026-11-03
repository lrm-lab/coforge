import { test, expect } from "bun:test";
import { setup } from "./fixtures/task-dependencies";

/** Blockers and subtasks against real PostgreSQL: the graph rules and the hard rules every status write passes. */

test("a cycle of blockers or of parents is refused, naming the tasks", async () => {
  const { db, run, make, refusal } = await setup();
  try {
    const [a, b, c] = await make("alice", 3);
    await run("alice", { operation: "amend", number: b!, blockedBy: [{ number: a! }] });
    await run("alice", { operation: "amend", number: c!, blockedBy: [{ number: b! }] });
    const cycle = await refusal(
      run("alice", { operation: "amend", number: a!, blockedBy: [{ number: c! }] }),
    );
    expect(cycle.code).toBe("INVALID_INPUT");
    expect(cycle.hint).toContain(`#${a}`);
    expect(cycle.hint).toContain(`#${c}`);
    expect(
      (await refusal(run("alice", { operation: "amend", number: a!, blockedBy: [{ number: a! }] })))
        .code,
    ).toBe("INVALID_INPUT");
    // The parent cycle uses siblings of their own: a task waiting for a later parent is refused
    // by the tree rule before the parent move is judged.
    const [p, q, r] = await make("alice", 3);
    await run("alice", { operation: "amend", number: q!, parent: { number: p! } });
    await run("alice", { operation: "amend", number: r!, parent: { number: q! } });
    const parents = await refusal(
      run("alice", { operation: "amend", number: p!, parent: { number: r! } }),
    );
    expect(parents.code).toBe("INVALID_INPUT");
    expect(parents.hint).toContain("below");
    // Five levels are allowed, a sixth is not.
    const [d, e, f] = await make("alice", 3);
    await run("alice", { operation: "amend", number: d!, parent: { number: r! } });
    await run("alice", { operation: "amend", number: e!, parent: { number: d! } });
    expect(
      (await refusal(run("alice", { operation: "amend", number: f!, parent: { number: e! } })))
        .hint,
    ).toContain("5 levels");
  } finally {
    await db.$disconnect();
  }
});

test("a blocker or parent in another conversation, or that does not exist, is refused", async () => {
  const { db, run, make, other, refusal } = await setup();
  try {
    const [one] = await make("alice", 1);
    const elsewhere = (
      await run(
        "alice",
        {
          operation: "create",
          titles: ["a", "b", "c"].map((title) => `${title} elsewhere`),
        },
        other.id,
      )
    ).tasks.map((task) => task.number);
    const missing = Math.max(...elsewhere) + 5;
    for (const command of [
      { operation: "create" as const, title: "x", blockedBy: [{ number: missing }] },
      { operation: "create" as const, title: "x", parent: { number: missing } },
      { operation: "amend" as const, number: one!, blockedBy: [{ number: missing }] },
      { operation: "amend" as const, number: one!, parent: { number: missing } },
    ])
      expect((await refusal(run("alice", command))).code).toBe("INVALID_INPUT");
  } finally {
    await db.$disconnect();
  }
});

test("deleting a blocker releases its dependents and deleting a parent leaves its children", async () => {
  const { db, run, make, show } = await setup();
  try {
    const [blocker, waiting, parent, child] = await make("alice", 4);
    await run("alice", {
      operation: "amend",
      number: waiting!,
      blockedBy: [{ number: blocker! }],
    });
    await run("alice", { operation: "amend", number: child!, parent: { number: parent! } });
    const withParent = (await show(parent!)).tasks[0]!;
    expect(withParent.subtasks).toEqual({ total: 1, finished: 0 });
    const tree = await show(parent!);
    expect(tree.subtree?.map((node) => !node.hidden && node.number)).toEqual([child!]);
    expect((await show(waiting!)).tasks[0]).toMatchObject({ blocked: true });
    expect((await show(blocker!)).blocking?.map((link) => !link.hidden && link.number)).toEqual([
      waiting!,
    ]);

    await run("alice", { operation: "delete", number: blocker! });
    await run("alice", { operation: "delete", number: parent! });
    expect((await show(waiting!)).tasks[0]).toMatchObject({
      blockedBy: [],
      blocked: false,
    });
    expect((await show(child!)).tasks[0]).toMatchObject({ parent: null });
  } finally {
    await db.$disconnect();
  }
});

test("a blocked task cannot be claimed or started until its blocker is finished, except by a manager", async () => {
  const { db, run, make, notices, finish, refusal, one } = await setup();
  try {
    const [blocker] = await make("alice", 1);
    const [waiting, forced, claimable] = await make("alice", 3, {
      blockedBy: [{ number: blocker! }],
    });
    const reserve = (number: number) =>
      run("alice", {
        operation: "assign",
        number,
        assignee: `agent:${one.id}`,
      });

    const claim = await run("one", { operation: "claim", number: waiting! });
    expect(claim.claims).toEqual([
      {
        number: waiting!,
        success: false,
        reason: "blocked",
        blockedBy: [{ hidden: false, number: blocker!, channel: null }],
      },
    ]);
    await reserve(waiting!);
    await reserve(forced!);
    const started = await refusal(
      run("one", {
        operation: "update",
        number: waiting!,
        status: "in_progress",
      }),
    );
    expect(started.code).toBe("CONFLICT");
    expect(started.errorId).toBe("task_blocked");
    expect(started.hint).toContain(`#${blocker}`);
    expect(started.hint).toContain("notified");
    // A Workspace owner or admin starts it and claims one anyway.
    await run("alice", {
      operation: "update",
      number: forced!,
      status: "in_progress",
    });
    const forcedClaim = await run("alice", {
      operation: "claim",
      number: claimable!,
    });
    expect(forcedClaim.claims).toMatchObject([{ number: claimable!, success: true }]);

    await finish("two", blocker!);
    for (const number of [waiting!, forced!]) {
      const unblocked = (await notices(number)).filter(
        (notice) => notice.kind === "task.unblocked",
      );
      expect(unblocked).toEqual([{ kind: "task.unblocked", agents: [one.id] }]);
    }
    const after = await run("one", { operation: "claim", number: waiting! });
    expect(after.claims).toMatchObject([{ number: waiting!, success: true }]);
  } finally {
    await db.$disconnect();
  }
});

test("amending the blockers is checked against the revision and allowed to the owner, creator or a manager", async () => {
  const { db, run, make, refusal } = await setup();
  try {
    const [task, blocker] = await make("bob", 2);
    const read = (await run("alice", { operation: "show", number: task! })).tasks[0]!;
    const stale = await refusal(
      run("bob", {
        operation: "amend",
        number: task!,
        blockedBy: [{ number: blocker! }],
        expectedRevision: read.revision + 3,
      }),
    );
    expect(stale.code).toBe("CONFLICT");
    const amended = await run("bob", {
      operation: "amend",
      number: task!,
      blockedBy: [{ number: blocker! }],
      expectedRevision: read.revision,
    });
    expect(amended.tasks[0]).toMatchObject({
      revision: read.revision + 1,
      blocked: true,
    });
    expect(amended.history).toMatchObject([
      {
        eventType: "dependencies_changed",
        payload: { added: [{ hidden: false, number: blocker!, channel: null }], removed: [] },
      },
    ]);
    const denied = await refusal(run("one", { operation: "amend", number: task!, blockedBy: [] }));
    expect(denied.code).toBe("ACCESS_DENIED");
    const parentDenied = await refusal(
      run("one", { operation: "amend", number: task!, parent: { number: blocker! } }),
    );
    expect(parentDenied.code).toBe("ACCESS_DENIED");
    const cleared = await run("alice", {
      operation: "amend",
      number: task!,
      blockedBy: [],
    });
    expect(cleared.tasks[0]).toMatchObject({ blockedBy: [], blocked: false });
    expect(cleared.history).toMatchObject([
      {
        eventType: "dependencies_changed",
        payload: { added: [], removed: [{ hidden: false, number: blocker!, channel: null }] },
      },
    ]);
  } finally {
    await db.$disconnect();
  }
});

test("a sub-task tree node names only the blockers still open", async () => {
  const { db, run, make, show } = await setup();
  try {
    const [parent, child, finished, open] = await make("alice", 4);
    await run("alice", { operation: "amend", number: child!, parent: { number: parent! } });
    await run("alice", {
      operation: "amend",
      number: child!,
      blockedBy: [{ number: finished! }, { number: open! }],
    });
    await run("alice", { operation: "update", number: finished!, status: "closed" });
    const node = (await show(parent!)).subtree?.[0];
    expect(node).toMatchObject({
      number: child!,
      blocked: true,
      blockedBy: [{ hidden: false, number: open!, channel: null }],
    });
  } finally {
    await db.$disconnect();
  }
});

test("list --ready returns todo tasks nobody holds that are not blocked", async () => {
  const { db, run, make, finish, one } = await setup();
  try {
    const [free, waiting, held, blocker] = await make("alice", 4);
    await run("alice", {
      operation: "amend",
      number: waiting!,
      blockedBy: [{ number: blocker! }],
    });
    await run("alice", {
      operation: "assign",
      number: held!,
      assignee: `agent:${one.id}`,
    });
    const ready = async () =>
      (await run("alice", { operation: "list", ready: true })).tasks.map((task) => task.number);
    expect(await ready()).toEqual([free!, blocker!]);
    await finish("two", blocker!);
    expect(await ready()).toEqual([free!, waiting!]);
  } finally {
    await db.$disconnect();
  }
});

test("a create cannot link a new task to itself or to a sibling made by the same command", async () => {
  const { db, run, make, refusal } = await setup();
  try {
    const [existing] = await make("alice", 1);
    const first = existing! + 1;
    for (const command of [
      { title: "self", blockedBy: [{ number: first }] },
      { titles: ["a", "b"], blockedBy: [{ number: first }, { number: first + 1 }] },
      { title: "self", parent: { number: first } },
      { titles: ["a", "b"], parent: { number: first + 1 } },
    ]) {
      const error = await refusal(run("alice", { operation: "create", ...command }));
      expect(error.code).toBe("INVALID_INPUT");
      expect(error.errorId).toBe("task_relation_invalid");
    }
    // Nothing was made by the refused creates; an existing task is still a fine blocker.
    const [fine] = await make("alice", 1, { blockedBy: [{ number: existing! }] });
    expect(fine).toBe(first);
  } finally {
    await db.$disconnect();
  }
});

test("adding a subtask needs the parent's owner, creator or a manager", async () => {
  const { db, run, make, refusal, one } = await setup();
  try {
    const [parent] = await make("alice", 1);
    await run("alice", { operation: "assign", number: parent!, assignee: `agent:${one.id}` });
    const [mine] = await make("bob", 1);
    const create = await refusal(
      run("bob", { operation: "create", title: "x", parent: { number: parent! } }),
    );
    expect(create.code).toBe("ACCESS_DENIED");
    expect(create.errorId).toBe("task_relation_denied");
    expect(create.hint).toContain(`#${parent}`);
    const amend = await refusal(
      run("bob", { operation: "amend", number: mine!, parent: { number: parent! } }),
    );
    expect(amend.errorId).toBe("task_relation_denied");
    // The parent's owner and a manager may; leaving a parent needs only the child's permission.
    await run("one", { operation: "create", title: "by the owner", parent: { number: parent! } });
    await run("alice", { operation: "amend", number: mine!, parent: { number: parent! } });
    const detached = await run("bob", { operation: "amend", number: mine!, parent: null });
    expect(detached.tasks[0]).toMatchObject({ parent: null });
  } finally {
    await db.$disconnect();
  }
});
