import { expect, test } from "bun:test";
import type { TaskPriorityLevel } from "@lrm/coforge-sdk/internal";
import { setup } from "./fixtures/task-dependencies";

/**
 * Task priority (task #470) against real PostgreSQL: five levels, `none` by default, set on create
 * and by `update` (with or without a status), recorded in history, sorting both lists, and who may
 * set it: anyone who may speak in the conversation, an Agent only on Tasks it created or in a
 * channel it coordinates, a Workspace owner or admin always.
 */

test("a task defaults to medium, takes a priority on create and update, and records the change", async () => {
  const { db, run, make, show, refusal, channel } = await setup();
  try {
    const [plain] = await make("bob", 1);
    expect((await show(plain!)).tasks[0]!.priority).toBe("medium");

    const [urgent] = await make("bob", 1, { priority: "urgent" });
    expect((await show(urgent!)).tasks[0]!.priority).toBe("urgent");

    const before = (await show(plain!)).tasks[0]!;
    const [raised] = (await run("bob", { operation: "update", number: plain!, priority: "high" }))
      .tasks;
    expect(raised).toMatchObject({ priority: "high", status: before.status });
    expect(raised!.revision).toBe(before.revision + 1);
    const taskConversationId = (
      await db.task.findUniqueOrThrow({
        where: { conversationId_number: { conversationId: channel.id, number: plain! } },
        select: { discussionConversationId: true },
      })
    ).discussionConversationId!;
    const raisedNotices = await db.systemMessage.findMany({
      where: { conversationId: taskConversationId, kind: "task.priority_changed" },
      orderBy: { message: { sequence: "asc" } },
    });
    expect(raisedNotices).toHaveLength(1);

    const [again] = (await run("bob", { operation: "update", number: plain!, priority: "high" }))
      .tasks;
    expect(again!.revision).toBe(raised!.revision);
    expect(
      await db.systemMessage.count({
        where: { conversationId: taskConversationId, kind: "task.priority_changed" },
      }),
    ).toBe(1);

    await run("bob", { operation: "claim", number: plain! });
    const [both] = (
      await run("bob", {
        operation: "update",
        number: plain!,
        status: "backlog",
        priority: "low",
      })
    ).tasks;
    expect(both).toMatchObject({ status: "backlog", priority: "low" });
    expect(
      await db.systemMessage.count({
        where: { conversationId: taskConversationId, kind: "task.priority_changed" },
      }),
    ).toBe(2);

    const history = await run("bob", { operation: "history", number: plain! });
    expect(
      history
        .history!.filter((event) => event.eventType === "priority_changed")
        .map((event) => event.payload),
    ).toEqual([
      { from: "none", to: "medium" },
      { from: "medium", to: "high" },
      { from: "high", to: "low" },
    ]);
    const created = await run("bob", { operation: "history", number: urgent! });
    expect(
      created
        .history!.filter((event) => event.eventType === "priority_changed")
        .map((e) => e.payload),
    ).toEqual([{ from: "none", to: "urgent" }]);

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
});

test("people set any task's priority; an Agent only its own or in the channel it coordinates", async () => {
  const { db, run, make, show, refusal, channel, one } = await setup();
  try {
    const [byBob] = await make("bob", 1);
    const [byOne] = await make("one", 1);

    await run("alice", { operation: "update", number: byOne!, priority: "low" });
    await run("bob", { operation: "update", number: byOne!, priority: "high" });
    await run("one", { operation: "update", number: byOne!, priority: "urgent" });
    expect((await show(byOne!)).tasks[0]!.priority).toBe("urgent");

    const refused = await refusal(
      run("two", { operation: "update", number: byOne!, priority: "low" }),
    );
    expect(refused.code).toBe("ACCESS_DENIED");
    expect(refused.hint).toContain("coordinat");
    expect(
      (await refusal(run("one", { operation: "update", number: byBob!, priority: "low" }))).code,
    ).toBe("ACCESS_DENIED");
    await run("two", { operation: "claim", number: byOne! });
    await run("two", { operation: "update", number: byOne!, status: "backlog" });

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

test("create and convert take a level, never none; a missing one defaults to medium", async () => {
  const { db, run, make, show, refusal, channel, principals } = await setup();
  try {
    const refused = await refusal(make("bob", 1, { priority: "none" as TaskPriorityLevel }));
    expect(refused.code).toBe("INVALID_INPUT");
    expect(refused.errorId).toBe("task_priority_invalid");
    expect(refused.hint).toContain("urgent");

    const [plain] = await make("bob", 1);
    expect((await show(plain!)).tasks[0]!.priority).toBe("medium");
    expect(
      (
        await refusal(
          run("bob", {
            operation: "update",
            number: plain!,
            priority: "none" as TaskPriorityLevel,
          }),
        )
      ).code,
    ).toBe("INVALID_INPUT");

    const sender = await db.conversationMember.findFirstOrThrow({
      where: { conversationId: channel.id, userId: principals.bob.userId },
    });
    const sourceMessage = async () => {
      const [row] = await db.$queryRaw<Array<{ sequence: number }>>`
        UPDATE "conversations"
        SET "lastSequence" = "lastSequence" + 1
        WHERE "id" = ${channel.id}::uuid
        RETURNING "lastSequence" AS "sequence"
      `;
      return db.message.create({
        data: {
          conversationId: channel.id,
          workspaceId: channel.workspaceId,
          senderMemberId: sender.id,
          body: `convert me ${crypto.randomUUID().slice(0, 8)}`,
          sequence: row!.sequence,
        },
      });
    };
    const source = await sourceMessage();
    const [convertedPlain] = (await run("bob", { operation: "convert", messageId: source.id }))
      .tasks;
    expect((await show(convertedPlain!.number)).tasks[0]!.priority).toBe("medium");

    const second = await sourceMessage();
    const [converted] = (
      await run("bob", { operation: "convert", messageId: second.id, priority: "high" })
    ).tasks;
    expect((await show(converted!.number)).tasks[0]!.priority).toBe("high");

    const third = await sourceMessage();
    expect(
      (
        await refusal(
          run("bob", {
            operation: "convert",
            messageId: third.id,
            priority: "none" as TaskPriorityLevel,
          }),
        )
      ).code,
    ).toBe("INVALID_INPUT");
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
      [a, "medium"],
      [b, "low"],
      [d, "low"],
    ]);

    for (const number of [a, b, c, d, e]) await run("one", { operation: "claim", number: number! });
    const mine = await board.execute(principals.one, {
      idempotencyKey: crypto.randomUUID(),
      operation: "list",
      mine: true,
    });
    expect(mine.tasks.map((task) => task.number)).toEqual([c, e, a, b, d]);
  } finally {
    await db.$disconnect();
  }
});
