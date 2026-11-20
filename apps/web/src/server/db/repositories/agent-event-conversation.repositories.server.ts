import type { Prisma } from "#src/generated/prisma/client";
import { APP_EVENTS_KIND } from "#src/server/app-agent-events/app-event-target.server";
import { isUniqueViolation } from "#src/server/db/unique-violation.server";
import { isDatabaseClient, type DatabaseScope } from "#src/server/db/transaction.server";

const createEventConversation = (scope: DatabaseScope, workspaceId: string, directKey: string) =>
  scope.conversation.create({
    data: { workspaceId, directKey, kind: APP_EVENTS_KIND },
    select: { id: true },
  });

export async function eventConversation(
  scope: DatabaseScope,
  workspaceId: string,
  directKey: string,
) {
  const where = { workspaceId_directKey: { workspaceId, directKey } };
  const root = isDatabaseClient(scope) ? scope : undefined;
  if (!root)
    await (scope as Prisma.TransactionClient).$executeRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${`event-conversation:${workspaceId}:${directKey}`}, 0))`;
  const found = await scope.conversation.findUnique({ where, select: { id: true } });
  if (found) return found.id;
  if (!root) return (await createEventConversation(scope, workspaceId, directKey)).id;
  try {
    return (await createEventConversation(scope, workspaceId, directKey)).id;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return (await scope.conversation.findUniqueOrThrow({ where, select: { id: true } })).id;
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
