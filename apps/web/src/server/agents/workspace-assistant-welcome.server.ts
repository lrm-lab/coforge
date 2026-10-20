import type { PrismaClient } from "#src/generated/prisma/client";

/** Called after the owning DM has been authorized. No parsing of model-authored content. */
export async function workspaceAssistantWelcome(
  db: PrismaClient,
  workspaceId: string,
  userId: string,
  conversationId: string,
) {
  const session = await db.workspaceAssistantSession.findFirst({
    where: { workspaceId, userId, agent: { conversations: { some: { conversationId } } } },
    select: { agentId: true },
  });
  if (!session) return undefined;
  const replied = await db.message.findFirst({
    where: { conversationId, sender: { userId } },
    select: { id: true },
  });
  if (replied) return undefined;
  return true;
}
