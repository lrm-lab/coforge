import type { PrismaClient } from "#src/generated/prisma/client";

/**
 * The conversations a person stops reading when they lose these channels: the channels
 * themselves and the task conversations of the tasks on them, whose subscriptions end with them
 * (a task conversation is read by its board's rule, `taskDiscussionAccess`).
 */
export async function withTaskDiscussions(
  db: Pick<PrismaClient, "task">,
  conversationIds: readonly string[],
): Promise<string[]> {
  if (conversationIds.length === 0) return [];
  const tasks = await db.task.findMany({
    where: {
      conversationId: { in: [...conversationIds] },
      discussionConversationId: { not: null },
    },
    select: { discussionConversationId: true },
  });
  return [...conversationIds, ...tasks.map((task) => task.discussionConversationId!)];
}
