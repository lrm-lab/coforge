import { test, expect } from "bun:test";
import { taskSelection } from "#src/server/tasks/task-view.server";
import { withNotices } from "#src/server/tasks/task-notice-posting.server";
import { setup } from "./fixtures/task-dependencies";

/** Cross-channel notices are written in the transaction of the change that causes them. */

test("concurrent task writes in two channels neither deadlock nor lose a cross-channel notice", async () => {
  for (let round = 0; round < 5; round += 1) {
    const { db, run, make, notices, one, other, channel } = await setup();
    try {
      const [a1, , a3] = await make("alice", 3);
      const [b1, b2] = await make("alice", 2, {}, other.id);
      await run("alice", {
        operation: "amend",
        number: a3!,
        blockedBy: [{ number: b2!, channel: other.channelName! }],
      });
      await run("alice", { operation: "assign", number: a3!, assignee: `agent:${one.id}` });
      await run("two", { operation: "claim", number: b2! }, other.id);
      await run("two", { operation: "update", number: b2!, status: "in_review" }, other.id);

      // Amending A#1 to wait for B#1 while B#2 is marked done, which unblocks A#3 in channel A.
      const both = Promise.all([
        run("alice", {
          operation: "amend",
          number: a1!,
          blockedBy: [{ number: b1!, channel: other.channelName! }],
        }),
        run("two", { operation: "update", number: b2!, status: "done" }, other.id),
      ]);
      const settled = await Promise.race([
        both,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("deadlocked")), 15_000),
        ),
      ]);
      expect(settled).toHaveLength(2);
      expect((await run("alice", { operation: "show", number: a1! })).tasks[0]!.blocked).toBe(true);
      expect((await notices(a3!)).filter((notice) => notice.kind === "task.unblocked")).toEqual([
        { kind: "task.unblocked", agents: [one.id] },
      ]);
      expect(channel.id).not.toBe(other.id);
    } finally {
      await db.$disconnect();
    }
  }
});

test("a failure after the notice step leaves neither the relation nor the notice", async () => {
  const { db, run, make, one, other, channel } = await setup();
  try {
    const [blocker] = await make("alice", 1, {}, other.id);
    const [waiting] = await make("alice", 1);
    await run("alice", { operation: "assign", number: waiting!, assignee: `agent:${one.id}` });
    const [blockerRow, task] = await Promise.all([
      db.task.findFirstOrThrow({
        where: { conversationId: other.id, number: blocker! },
        select: { id: true },
      }),
      db.task.findFirstOrThrow({
        where: { conversationId: channel.id, number: waiting! },
        select: taskSelection,
      }),
    ]);
    const ports = { db, reader: "people" as const, dependencies: {} };
    const noticeId = crypto.randomUUID();
    const attempt = (fail: boolean) =>
      withNotices(
        ports,
        { conversationId: other.id, workspaceId: channel.workspaceId },
        async (tx, notices) => {
          await tx.taskDependency.create({
            data: {
              taskId: task.id,
              blockedByTaskId: blockerRow.id,
              conversationId: channel.id,
              workspaceId: channel.workspaceId,
              creatorMemberId: task.creator.id,
            },
          });
          await notices.toOwner({
            id: noticeId,
            task,
            owner: task.owner,
            deliverTo: one.id,
            content: () => ({
              body: "probe",
              system: {
                kind: "task.released",
                params: { task: { taskId: task.id, number: task.number, title: "" }, owner: null },
              },
            }),
          });
          if (fail) throw new Error("after the notice step");
        },
      );
    await expect(attempt(true)).rejects.toThrow("after the notice step");
    expect(await db.taskDependency.count({ where: { taskId: task.id } })).toBe(0);
    expect(await db.message.count({ where: { id: noticeId } })).toBe(0);

    // The same writes without the failure commit together, the notice in the dependent's own channel.
    await attempt(false);
    expect(await db.taskDependency.count({ where: { taskId: task.id } })).toBe(1);
    const notice = await db.message.findUniqueOrThrow({
      where: { id: noticeId },
      select: { conversationId: true, deliveries: { select: { agentId: true } } },
    });
    expect(notice.conversationId).not.toBe(other.id);
    expect(notice.deliveries.map((d) => d.agentId)).toEqual([one.id]);
  } finally {
    await db.$disconnect();
  }
});
