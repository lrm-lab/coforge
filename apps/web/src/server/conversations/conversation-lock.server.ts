import type { Prisma } from "#src/generated/prisma/client";

export function lockConversation(tx: Prisma.TransactionClient, conversationId: string) {
  return tx.$queryRaw`SELECT "id" FROM "conversations" WHERE "id" = ${conversationId}::uuid FOR NO KEY UPDATE`;
}

export async function lockConversations(
  tx: Prisma.TransactionClient,
  conversationIds: readonly string[],
) {
  const ids = [...new Set(conversationIds)].sort();
  if (ids.length === 0) return [];
  if (ids.length === 1) return lockConversation(tx, ids[0]!);
  return tx.$queryRaw`SELECT "id" FROM "conversations" WHERE "id" = ANY(${ids}::uuid[]) ORDER BY "id" FOR NO KEY UPDATE`;
}

export function lockWorkspaceConversations(tx: Prisma.TransactionClient, workspaceId: string) {
  return tx.$queryRaw`SELECT "id" FROM "conversations" WHERE "workspaceId" = ${workspaceId}::uuid ORDER BY "id" FOR NO KEY UPDATE`;
}

export function lockWorkspaceTaskWrites(tx: Prisma.TransactionClient, workspaceId: string) {
  return tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`task-writes:${workspaceId}`}, 0))::text`;
}
