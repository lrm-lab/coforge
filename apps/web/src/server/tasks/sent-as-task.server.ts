import type { Prisma } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import type { SentMessageHook } from "#src/server/conversations/sent-message-hook.server";
import { creationChanges, historyRows } from "./task-history.server";
import { taskSelection } from "./task-view.server";

/**
 * Makes an existing top-level message a Task: the conversation's next number, the message's body
 * as its title, and its creation in the history. The caller's transaction holds the conversation
 * lock, so numbers stay in order.
 */
export async function createMessageTask(
  tx: Prisma.TransactionClient,
  message: { id: string; conversationId: string; workspaceId: string; body: string },
  creator: {
    id: string;
    agentId: string | null;
    user?: { username: string } | null;
    agent?: { name: string } | null;
  },
) {
  const allocated = await tx.$queryRaw<Array<{ number: number }>>`
    UPDATE "conversations"
    SET "nextTaskNumber" = "nextTaskNumber" + 1
    WHERE "id" = ${message.conversationId}::uuid
    RETURNING "nextTaskNumber" - 1 AS "number"
  `;
  if (allocated[0]?.number === undefined) throw new AppError("NOT_FOUND");
  const task = await tx.task.create({
    data: {
      messageId: message.id,
      conversationId: message.conversationId,
      workspaceId: message.workspaceId,
      number: allocated[0].number,
      title: message.body.slice(0, 8_000),
      creatorMemberId: creator.id,
    },
    select: taskSelection,
  });
  await tx.taskHistoryEvent.createMany({
    data: historyRows(task.messageId, creator, creationChanges(task), 0),
  });
  return task;
}

/**
 * "As task" in the composer: the message being sent is a Task from the moment it exists, with
 * every upload it carries, as Raft's composer sends it (`/v2/messages` with `asTask`). Only a
 * top-level message can be a Task, as `convert` holds. The caller announces it once the send has
 * committed (`TaskBoard.announceSentTask`).
 */
export const sentMessageBecomesTask: SentMessageHook = async (tx, message) => {
  if (message.threadRootId) throw new AppError("INVALID_INPUT");
  const creator = await tx.conversationMember.findUniqueOrThrow({
    where: { id: message.senderMemberId },
    select: {
      id: true,
      agentId: true,
      user: { select: { username: true } },
      agent: { select: { name: true } },
    },
  });
  await createMessageTask(tx, message, creator);
};
