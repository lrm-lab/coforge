import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { APP_EVENTS_KIND } from "#src/server/app-agent-events/app-event-target.server";
import { isUniqueViolation } from "#src/server/db/unique-violation.server";

export async function eventConversation(db: PrismaClient, workspaceId: string, directKey: string) {
  const where = { workspaceId_directKey: { workspaceId, directKey } };
  const found = await db.conversation.findUnique({ where, select: { id: true } });
  if (found) return found.id;
  try {
    return (
      await db.conversation.create({
        data: { workspaceId, directKey, kind: APP_EVENTS_KIND },
        select: { id: true },
      })
    ).id;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return (await db.conversation.findUniqueOrThrow({ where, select: { id: true } })).id;
  }
}

export function eventMember(
  tx: Prisma.TransactionClient,
  conversationId: string,
  workspaceId: string,
  agentId: string,
) {
  return tx.conversationMember.upsert({
    where: { conversationId_agentId: { conversationId, agentId } },
    create: { conversationId, workspaceId, agentId },
    update: { leftAt: null },
    select: { id: true },
  });
}
