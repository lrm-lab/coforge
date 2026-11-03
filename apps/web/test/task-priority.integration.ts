import { expect, test } from "bun:test";
import { setup } from "./fixtures/task-dependencies";

/**
 * Task priority (task #470) against real PostgreSQL: five levels, `none` by default, set on create
 * and by `update` (with or without a status), recorded in history, sorting both lists, and who may
 * set it: anyone who may speak in the conversation, an Agent only on Tasks it created or in a
 * channel it coordinates, a Workspace owner or admin always.
 */

test("a task starts at none, takes a priority on create and update, and records the change", async () => {
  for (const tasksV2 of [true, false]) {
    const { db, run, make, show, refusal } = await setup({ tasksV2 });
    try {
      const [plain] = await make("bob", 1);
      expect((await show(plain!)).tasks[0]!.priority).toBe("none");

      const [urgent] = await make("bob", 1, { priority: "urgent" });
      expect((await show(urgent!)).tasks[0]!.priority).toBe("urgent");

      // `update` with only a priority changes nothing else; the revision moves once.
      const before = (await show(plain!)).tasks[0]!;
      const [raised] = (await run("bob", { operation: "update", number: plain!, priority: "high" }))
        .tasks;
      expect(raised).toMatchObject({ priority: "high", status: before.status });
      expect(raised!.revision).toBe(before.revision + 1);

      // The same priority again writes nothing.
      const [again] = (await run("bob", { operation: "update", number: plain!, priority: "high" }))
        .tasks;
      expect(again!.revision).toBe(raised!.revision);

      // With a status, both change in one write.
      await run("bob", { operation: "claim", number: plain! });
      const [both] = (
        await run("bob", {
          operation: "update",
          number: plain!,
          status: "in_review",
          priority: "low",
        })
      ).tasks;
      expect(both).toMatchObject({ status: "in_review", priority: "low" });

      const history = await run("bob", { operation: "history", number: plain! });
      expect(
        history
          .history!.filter((event) => event.eventType === "priority_changed")
          .map((event) => event.payload),
      ).toEqual([
        { from: "none", to: "high" },
        { from: "high", to: "low" },
      ]);
      const created = await run("bob", { operation: "history", number: urgent! });
      expect(
        created
          .history!.filter((event) => event.eventType === "priority_changed")
          .map((e) => e.payload),
      ).toEqual([{ from: "none", to: "urgent" }]);

      // An unknown level, or an update with neither status nor priority, is refused.
      expect(
        (
          await refusal(
            run("bob", { operation: "update", number: plain!, priority: "asap" as "high" }),
          )
        ).code,
      ).toBe("INVALID_INPUT");
      expect((await refusal(run("bob", { operation: "update", number: plain! }))).code).toBe(
        "INVALID_INPUT",
      );
      expect((await refusal(make("bob", 1, { priority: "soon" as "high" }))).code).toBe(
        "INVALID_INPUT",
      );
    } finally {
      await db.$disconnect();
    }
  }
});

test("people set any task's priority; an Agent only its own or in the channel it coordinates", async () => {
  const { db, run, make, show, refusal, channel, one } = await setup();
  try {
    const [byBob] = await make("bob", 1);
    const [byOne] = await make("one", 1);

    // A member who neither created nor owns it.
    await run("alice", { operation: "update", number: byOne!, priority: "medium" });
    await run("bob", { operation: "update", number: byOne!, priority: "high" });
    // The creating Agent on its own Task.
    await run("one", { operation: "update", number: byOne!, priority: "urgent" });
    expect((await show(byOne!)).tasks[0]!.priority).toBe("urgent");

    // Another Agent, even holding the Task, is refused, with the reason.
    const refused = await refusal(
      run("two", { operation: "update", number: byOne!, priority: "low" }),
    );
    expect(refused.code).toBe("ACCESS_DENIED");
    expect(refused.hint).toContain("coordinat");
    expect(
      (await refusal(run("one", { operation: "update", number: byBob!, priority: "low" }))).code,
    ).toBe("ACCESS_DENIED");
    // A status move it could make stays allowed: the check is on the priority only.
    await run("two", { operation: "claim", number: byOne! });
    await run("two", { operation: "update", number: byOne!, status: "in_review" });

    // The channel's coordinator may prioritise every Task in it.
    await db.conversation.update({
      where: { id: channel.id },
      data: { coordinatorAgentId: one.id },
    });
    await run("one", { operation: "update", number: byBob!, priority: "low" });
    expect((await show(byBob!)).tasks[0]!.priority).toBe("low");
  } finally {
    await db.$disconnect();
  }
});

test("an Agent that is a Workspace admin sets any task's priority", async () => {
  const { db, run, make, show, two } = await setup();
  try {
    const [byBob] = await make("bob", 1);
    await db.agent.update({ where: { id: two.id }, data: { role: "admin" } });
    await run("two", { operation: "update", number: byBob!, priority: "high" });
    expect((await show(byBob!)).tasks[0]!.priority).toBe("high");
  } finally {
    await db.$disconnect();
  }
});

test("lists sort by priority, highest first, then oldest first within a level", async () => {
  const { db, board, principals, run, make } = await setup();
  try {
    const [a, b, c, d, e] = await make("alice", 5);
    await run("alice", { operation: "update", number: b!, priority: "low" });
    await run("alice", { operation: "update", number: c!, priority: "urgent" });
    await run("alice", { operation: "update", number: d!, priority: "low" });
    await run("alice", { operation: "update", number: e!, priority: "high" });
    const listed = await run("alice", { operation: "list" });
    expect(listed.tasks.map((task) => [task.number, task.priority])).toEqual([
      [c, "urgent"],
      [e, "high"],
      [b, "low"],
      [d, "low"],
      [a, "none"],
    ]);

    for (const number of [a, b, c, d, e]) await run("one", { operation: "claim", number: number! });
    const mine = await board.execute(principals.one, {
      idempotencyKey: crypto.randomUUID(),
      operation: "list",
      mine: true,
    });
    expect(mine.tasks.map((task) => task.number)).toEqual([c, e, b, d, a]);
  } finally {
    await db.$disconnect();
  }
});
