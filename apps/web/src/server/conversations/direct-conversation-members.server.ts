import type { PrismaClient } from "#src/generated/prisma/client";

/**
 * Opening a direct conversation that already exists gives each of these people their member row
 * back if it is missing altogether: a Workspace removal once deleted those rows. Both kinds of
 * direct conversation (with a person, with an Agent) restore through here.
 */
export async function restoreDirectConversationMembers(
  db: Pick<PrismaClient, "conversationMember">,
  input: { conversationId: string; workspaceId: string; userIds: readonly string[] },
) {
  // The common case is nobody missing — a sidebar read must not write. A member who left keeps
  // its leftAt row (skipDuplicates would not revive it either), so "missing" means no row at all.
  const present = await db.conversationMember.findMany({
    where: { conversationId: input.conversationId, userId: { in: [...input.userIds] } },
    select: { userId: true },
  });
  const missing = input.userIds.filter(
    (userId) => !present.some((member) => member.userId === userId),
  );
  if (!missing.length) return;
  await db.conversationMember.createMany({
    data: missing.map((userId) => ({
      conversationId: input.conversationId,
      workspaceId: input.workspaceId,
      userId,
    })),
    skipDuplicates: true,
  });
}
