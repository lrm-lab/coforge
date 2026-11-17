import { expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { TaskBoard } from "#src/server/tasks/task-board.server";
import { setup } from "./fixtures/task-dependencies";

test("unfinished reads include Backlog while ready excludes it and writes stay closed", async () => {
  const { db, principals, channel, run: fixtureRun } = await setup();
  const rollback = new Error("rollback Backlog fixture");
  try {
    const parked = (await fixtureRun("alice", { operation: "create", title: "Parked fixture" }))
      .tasks[0]!;
    await expect(
      db.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '5s'");
          await tx.$executeRawUnsafe('ALTER TABLE "tasks" DROP CONSTRAINT "tasks_status_check"');
          await tx.task.update({ where: { id: parked.id }, data: { status: "backlog" } });
          const board = new TaskBoard(tx as PrismaClient);
          const run = (fields: object) =>
            board.execute(principals.alice, {
              operation: "list",
              conversationId: channel.id,
              idempotencyKey: crypto.randomUUID(),
              ...fields,
            });
          expect((await run({})).tasks.some((task) => task.id === parked.id)).toBe(true);
          expect(
            (
              await board.overview(
                principals.alice.workspaceId,
                (principals.alice as { userId: string }).userId,
              )
            ).tasks.some((task) => task.id === parked.id),
          ).toBe(true);
          expect((await run({ status: "backlog" })).tasks.map((task) => task.id)).toEqual([
            parked.id,
          ]);
          expect((await run({ ready: true })).tasks.some((task) => task.id === parked.id)).toBe(
            false,
          );
          await expect(
            board.execute(principals.alice, {
              operation: "update",
              conversationId: channel.id,
              idempotencyKey: crypto.randomUUID(),
              number: parked.number,
              status: "backlog" as never,
            }),
          ).rejects.toMatchObject({ code: "INVALID_INPUT" });
          throw rollback;
        },
        { timeout: 20_000 },
      ),
    ).rejects.toBe(rollback);
    expect((await db.task.findUniqueOrThrow({ where: { id: parked.id } })).status).toBe("todo");
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
