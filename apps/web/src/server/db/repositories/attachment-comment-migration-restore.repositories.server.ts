import { Prisma } from "#src/generated/prisma/client";
import type { AttachmentCommentMigrationJournal } from "#src/server/attachments/attachment-comment-migration-journal.server";
import {
  deferCommentMigrationKeys,
  finishCommentMigrationKeys,
  dropOrdinaryCommentMetadataKey,
  restoreLegacyCommentMetadataKey,
} from "./attachment-comment-migration-constraints.repositories.server";
import {
  insertCommentMigrationRows,
  migrationIds,
  migrationRelation,
  migrationText,
  migrationNullableText,
  migrationNumber,
} from "./attachment-comment-migration-journal.repositories.server";

/** Caller has locked the scope and verified its exact post-commit fingerprint. */
export async function restoreCommentMigrationCopy(
  tx: Prisma.TransactionClient,
  journal: AttachmentCommentMigrationJournal,
) {
  const { scope, before, plan } = journal;
  await deferCommentMigrationKeys(tx, scope, before);
  await dropOrdinaryCommentMetadataKey(tx, scope);
  await insertCommentMigrationRows(
    tx,
    scope,
    "conversations",
    before.conversations.filter((row) =>
      scope.oldConversationIds.includes(migrationText(row, "id")),
    ),
  );
  await insertCommentMigrationRows(
    tx,
    scope,
    "conversation_members",
    before.members.filter((row) =>
      scope.oldConversationIds.includes(migrationText(row, "conversationId")),
    ),
  );
  await insertCommentMigrationRows(tx, scope, "attachment_comment_threads", before.threads);
  await tx.$executeRaw(
    Prisma.sql`UPDATE ${migrationRelation(scope.schema, "messages")} SET "threadRootId" = NULL WHERE ${migrationIds(Prisma.sql`id`, scope.messageIds)}`,
  );
  for (const row of before.messages) {
    const changed =
      await tx.$executeRaw(Prisma.sql`UPDATE ${migrationRelation(scope.schema, "messages")}
      SET "conversationId" = ${migrationText(row, "conversationId")}::uuid,
        sequence = ${migrationNumber(row, "sequence")}, "senderMemberId" = ${migrationNullableText(row, "senderMemberId")}::uuid
      WHERE id = ${migrationText(row, "id")}::uuid`);
    if (changed !== 1) throw new Error("Rollback message missing");
  }
  const members = new Map(
    journal.resolvedMembers.map((row) => [row.fromMemberId, row.targetMemberId]),
  );
  for (const [table, rows] of [
    ["message_reactions", before.reactions],
    ["message_mentions", before.mentions],
    ["saved_messages", before.saved],
  ] as const) {
    for (const row of rows.filter((entry) =>
      scope.messageIds.includes(migrationText(entry, "messageId")),
    )) {
      const currentMember = members.get(migrationText(row, "memberId"));
      if (!currentMember) throw new Error("Rollback actor mapping missing");
      const emoji =
        table === "message_reactions"
          ? Prisma.sql`AND emoji = ${migrationText(row, "emoji")}`
          : Prisma.empty;
      const changed =
        await tx.$executeRaw(Prisma.sql`UPDATE ${migrationRelation(scope.schema, table)} SET "memberId" = ${migrationText(row, "memberId")}::uuid
        WHERE "messageId" = ${migrationText(row, "messageId")}::uuid AND "memberId" = ${currentMember}::uuid ${emoji}`);
      if (changed !== 1) throw new Error("Rollback reference missing");
    }
  }
  // Restore old nesting only after every old conversation and message sequence is back.
  for (const row of before.messages) {
    await tx.$executeRaw(Prisma.sql`UPDATE ${migrationRelation(scope.schema, "messages")} SET "threadRootId" = ${migrationNullableText(row, "threadRootId")}::uuid
      WHERE id = ${migrationText(row, "id")}::uuid`);
  }
  for (const cursor of plan.threadReadMappings) {
    await tx.$executeRaw(Prisma.sql`DELETE FROM ${migrationRelation(scope.schema, "thread_reads")}
      WHERE "memberId" = ${cursor.memberId}::uuid AND "rootMessageId" = ${cursor.rootMessageId}::uuid`);
  }
  const readKeys = new Set(
    plan.threadReadMappings.map((row) => `${row.memberId}:${row.rootMessageId}`),
  );
  await insertCommentMigrationRows(
    tx,
    scope,
    "thread_reads",
    before.reads.filter(
      (row) =>
        scope.oldConversationIds.includes(migrationText(row, "conversationId")) ||
        readKeys.has(`${migrationText(row, "memberId")}:${migrationText(row, "rootMessageId")}`),
    ),
  );
  await insertCommentMigrationRows(
    tx,
    scope,
    "thread_follows",
    before.follows.filter((row) =>
      scope.oldConversationIds.includes(migrationText(row, "conversationId")),
    ),
  );
  for (const cursor of plan.assistantReadMappings) {
    await tx.$executeRaw(Prisma.sql`DELETE FROM ${migrationRelation(scope.schema, "workspace_assistant_read_cursors")}
      WHERE "sessionId" = ${cursor.sessionId}::uuid AND "conversationId" = ${cursor.conversationId}::uuid AND scope = ${cursor.scope}`);
  }
  const assistantKeys = new Set(
    plan.assistantReadMappings.map((row) => `${row.sessionId}:${row.conversationId}:${row.scope}`),
  );
  await insertCommentMigrationRows(
    tx,
    scope,
    "workspace_assistant_read_cursors",
    before.assistantCursors.filter(
      (row) =>
        scope.oldConversationIds.includes(migrationText(row, "conversationId")) ||
        assistantKeys.has(
          `${migrationText(row, "sessionId")}:${migrationText(row, "conversationId")}:${migrationText(row, "scope")}`,
        ),
    ),
  );
  await tx.$executeRaw(
    Prisma.sql`DELETE FROM ${migrationRelation(scope.schema, "conversation_members")} WHERE ${migrationIds(Prisma.sql`id`, journal.createdMemberIds)}`,
  );
  await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
  await restoreLegacyCommentMetadataKey(tx, scope, before, journal.createdAttachmentIndex);
  await finishCommentMigrationKeys(tx, scope, before);
}
