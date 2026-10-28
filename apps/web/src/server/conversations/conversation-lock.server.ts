import type { Prisma } from "#src/generated/prisma/client";

/**
 * Take the conversation's row lock for the rest of the transaction. Every writer that
 * allocates a message sequence or Task number serializes here.
 * FOR NO KEY UPDATE: the row's key never changes under the lock, and the weaker level lets a
 * concurrent write's foreign-key check (FOR KEY SHARE — an upload referencing the conversation)
 * proceed instead of waiting for the whole send to commit.
 */
export function lockConversation(tx: Prisma.TransactionClient, conversationId: string) {
  return tx.$queryRaw`SELECT "id" FROM "conversations" WHERE "id" = ${conversationId}::uuid FOR NO KEY UPDATE`;
}

/** Every conversation row of a Workspace, locked the same way and in id order, so two lockers of
 * several rows never wait on each other: the Workspace delete holds off each writer above until
 * its conversations are gone. */
export function lockWorkspaceConversations(tx: Prisma.TransactionClient, workspaceId: string) {
  return tx.$queryRaw`SELECT "id" FROM "conversations" WHERE "workspaceId" = ${workspaceId}::uuid ORDER BY "id" FOR NO KEY UPDATE`;
}
