import type { PrismaClient } from "#src/generated/prisma/client";

/** The assignment notice a new task's own conversation opens with: its text and message id. */
export async function assignmentNotice(db: PrismaClient, taskId: string) {
  const task = await db.task.findUniqueOrThrow({
    where: { id: taskId },
    select: { discussionConversationId: true },
  });
  return db.message.findFirstOrThrow({
    where: { conversationId: task.discussionConversationId! },
    orderBy: { sequence: "asc" },
    select: { id: true, body: true },
  });
}
