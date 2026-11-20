import { expect, test } from "bun:test";
import { setup } from "./fixtures/task-dependencies";

test("Backlog is writable with optional reason, included in unfinished reads, and excluded from ready", async () => {
  const { db, board, principals, run } = await setup();
  try {
    const created = (await run("alice", { operation: "create", title: "Parked fixture" }))
      .tasks[0]!;
    const parked = (
      await run("alice", {
        operation: "update",
        number: created.number,
        status: "backlog",
        reason: "Waiting for next milestone",
      })
    ).tasks[0]!;
    expect(parked.status).toBe("backlog");
    expect(
      (await run("alice", { operation: "list" })).tasks.some((task) => task.id === parked.id),
    ).toBe(true);
    expect(
      (
        await board.overview(
          principals.alice.workspaceId,
          (principals.alice as { userId: string }).userId,
        )
      ).tasks.some((task) => task.id === parked.id),
    ).toBe(true);
    expect(
      (await run("alice", { operation: "list", status: "backlog" })).tasks.map((task) => task.id),
    ).toEqual([parked.id]);
    expect(
      (await run("alice", { operation: "list", ready: true })).tasks.some(
        (task) => task.id === parked.id,
      ),
    ).toBe(false);
    const history = (await run("alice", { operation: "history", number: parked.number })).history;
    expect(history?.at(-1)).toMatchObject({
      eventType: "status_changed",
      payload: { from: "todo", to: "backlog", reason: "Waiting for next milestone" },
    });
  } finally {
    try {
      await db.workspace.delete({ where: { id: principals.alice.workspaceId } });
      await db.user.deleteMany({
        where: {
          id: {
            in: [principals.alice, principals.bob].flatMap((principal) =>
              "userId" in principal && principal.userId ? [principal.userId] : [],
            ),
          },
        },
      });
    } finally {
      await db.$disconnect();
    }
  }
});
