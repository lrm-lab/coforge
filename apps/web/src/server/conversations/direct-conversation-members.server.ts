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
  await db.conversationMember.createMany({
    data: input.userIds.map((userId) => ({
      conversationId: input.conversationId,
      workspaceId: input.workspaceId,
      userId,
    })),
    skipDuplicates: true,
  });
}
