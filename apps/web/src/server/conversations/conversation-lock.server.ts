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

/**
 * Serialize every Task write of a Workspace that has Tasks v2 on. A Task write there can post a
 * notice in another conversation (finishing a Task wakes one that waits for it in another channel)
 * and checks a graph that spans conversations. Taken before any conversation lock and never after
 * one, so every Task writer acquires in the same order and none waits in a circle: a plain message
 * send holds one conversation lock and waits for no other lock while holding it.
 */
export function lockWorkspaceTaskWrites(tx: Prisma.TransactionClient, workspaceId: string) {
  return tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`task-writes:${workspaceId}`}, 0))::text`;
}
