import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { creationChanges, historyRows } from "#src/server/tasks/task-history.server";
import { taskSelection } from "#src/server/tasks/task-view.server";

/**
 * A Task from before task conversations: its own message in the channel (`messageId`), no
 * conversation of its own. The board no longer makes these; they stay in the database.
 */
export async function legacyMessageTask(
  db: PrismaClient,
  where: {
    conversationId: string;
    workspaceId: string;
    creatorMemberId: string;
    title: string;
    ownerMemberId?: string;
    status?: string;
  },
) {
  return db.$transaction(async (tx: Prisma.TransactionClient) => {
    const [{ number, sequence }] = await tx.$queryRaw<Array<{ number: number; sequence: number }>>`
      UPDATE "conversations"
      SET "nextTaskNumber" = "nextTaskNumber" + 1, "lastSequence" = "lastSequence" + 1
      WHERE "id" = ${where.conversationId}::uuid
      RETURNING "nextTaskNumber" - 1 AS "number", "lastSequence" AS "sequence"
    `;
    const message = await tx.message.create({
      data: {
        conversationId: where.conversationId,
        workspaceId: where.workspaceId,
        senderMemberId: where.creatorMemberId,
        body: where.title,
        sequence: sequence!,
      },
    });
    const task = await tx.task.create({
      data: {
        id: Bun.randomUUIDv7(),
        messageId: message.id,
        conversationId: where.conversationId,
        workspaceId: where.workspaceId,
        number: number!,
        title: where.title,
        creatorMemberId: where.creatorMemberId,
        ...(where.ownerMemberId && { ownerMemberId: where.ownerMemberId }),
        ...(where.status && { status: where.status }),
      },
      select: taskSelection,
    });
    await tx.taskHistoryEvent.createMany({
      data: historyRows(task.id, { agentId: null }, creationChanges(task), 0),
    });
    return { task, message };
  });
}
