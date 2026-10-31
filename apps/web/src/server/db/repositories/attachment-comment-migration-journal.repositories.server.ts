import {
  COMMENT_MIGRATION_TABLES,
  parseAttachmentCommentMigrationJournal,
} from "#src/server/attachments/attachment-comment-migration-journal.server";
import { Prisma } from "#src/generated/prisma/client";
import type {
  AttachmentCommentMigrationJournal,
  CommentMigrationBackup,
  CommentMigrationScope,
  CommentMigrationIntegrity,
  MigrationRow,
} from "#src/server/attachments/attachment-comment-migration-journal.server";
import type { AttachmentCommentMigrationSnapshot } from "#src/server/attachments/attachment-comment-migration.server";

export const migrationTables = COMMENT_MIGRATION_TABLES;
export type MigrationTable = (typeof migrationTables)[number];
export const migrationIdentifier = (value: string) =>
  Prisma.raw(`"${value.replaceAll('"', '""')}"`);
export const migrationRelation = (schema: string, table: MigrationTable) =>
  Prisma.sql`${migrationIdentifier(schema)}.${migrationIdentifier(table)}`;
export function migrationIds(column: Prisma.Sql, ids: readonly string[]) {
  return Prisma.sql`${column} IN (SELECT id::uuid FROM jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb) AS selected(id))`;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a === b ? 0 : a < b ? -1 : 1))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  return value;
}
export function migrationFingerprint(value: unknown) {
  return new Bun.CryptoHasher("sha256")
    .update(JSON.stringify(canonical(value)) ?? "undefined")
    .digest("hex");
}
export function migrationText(row: MigrationRow, key: string): string {
  if (typeof row[key] !== "string") throw new Error(`Invalid migration backup field ${key}`);
  return row[key];
}
export function migrationNullableText(row: MigrationRow, key: string): string | null {
  return row[key] === null ? null : migrationText(row, key);
}
export function migrationNumber(row: MigrationRow, key: string): number {
  if (typeof row[key] !== "number" || !Number.isSafeInteger(row[key]))
    throw new Error(`Invalid migration backup field ${key}`);
  return row[key];
}
export function commentMigrationScope(
  snapshot: AttachmentCommentMigrationSnapshot,
  identity: { database: string; schema: string },
): CommentMigrationScope {
  const oldConversationIds = [...new Set(snapshot.threads.map((row) => row.conversationId))].sort();
  return {
    ...identity,
    oldConversationIds,
    sourceConversationIds: [
      ...new Set(snapshot.threads.map((row) => row.sourceConversationId)),
    ].sort(),
    attachmentIds: snapshot.threads.map((row) => row.attachmentId).sort(),
    messageIds: snapshot.messages.map((row) => row.id).sort(),
    oldMemberIds: snapshot.members
      .filter((row) => oldConversationIds.includes(row.conversationId))
      .map((row) => row.id)
      .sort(),
  };
}
export async function commentMigrationIntegrity(
  tx: Prisma.TransactionClient,
): Promise<CommentMigrationIntegrity> {
  const constraints = await tx.$queryRaw<CommentMigrationIntegrity["constraints"]>`
    SELECT child.relname::text AS "table", c.conname::text AS name, c.contype::text AS kind,
      parent.relname::text AS target, pg_get_constraintdef(c.oid) AS definition,
      c.condeferrable AS deferrable, c.condeferred AS deferred, c.convalidated AS validated
    FROM pg_constraint c JOIN pg_class child ON child.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = child.relnamespace LEFT JOIN pg_class parent ON parent.oid = c.confrelid
    WHERE n.nspname = current_schema() AND child.relname::text IN (
      SELECT jsonb_array_elements_text(${JSON.stringify(migrationTables)}::jsonb)
    ) ORDER BY child.relname, c.conname
  `;
  const indexes = await tx.$queryRaw<CommentMigrationIntegrity["indexes"]>`
    SELECT indexname::text AS name, indexdef AS definition FROM pg_indexes
    WHERE schemaname = current_schema() AND tablename::text IN (
      SELECT jsonb_array_elements_text(${JSON.stringify(migrationTables)}::jsonb)
    ) ORDER BY indexname
  `;
  return { constraints, indexes };
}
export async function captureCommentMigration(
  tx: Prisma.TransactionClient,
  scope: CommentMigrationScope,
): Promise<CommentMigrationBackup> {
  const conversations = [...new Set([...scope.oldConversationIds, ...scope.sourceConversationIds])];
  const byConversation = migrationIds(Prisma.sql`t."conversationId"`, conversations);
  const byAttachment = migrationIds(Prisma.sql`t."attachmentId"`, scope.attachmentIds);
  const rows = async (table: MigrationTable, where: Prisma.Sql) => {
    const result = await tx.$queryRaw<{ value: MigrationRow }[]>(Prisma.sql`
      SELECT to_jsonb(t) AS value FROM ${migrationRelation(scope.schema, table)} t WHERE ${where} ORDER BY to_jsonb(t)::text
    `);
    return result.map((row) => row.value);
  };
  const data = {
    conversations: await rows("conversations", migrationIds(Prisma.sql`t.id`, conversations)),
    members: await rows("conversation_members", byConversation),
    messages: await rows("messages", migrationIds(Prisma.sql`t.id`, scope.messageIds)),
    attachments: await rows("attachments", migrationIds(Prisma.sql`t.id`, scope.attachmentIds)),
    comments: await rows("attachment_comments", byAttachment),
    threads: await rows("attachment_comment_threads", byAttachment),
    reactions: await rows("message_reactions", byConversation),
    mentions: await rows("message_mentions", byConversation),
    saved: await rows("saved_messages", byConversation),
    reads: await rows("thread_reads", byConversation),
    follows: await rows("thread_follows", byConversation),
    assistantCursors: await rows("workspace_assistant_read_cursors", byConversation),
    mentionActions: await rows("pending_mention_actions", byConversation),
    deliveries: await rows("agent_message_deliveries", byConversation),
  };
  // Existing ordinary message bodies are not copied into the journal; their hashes detect edits.
  const sourceMessages = await tx.$queryRaw<CommentMigrationBackup["sourceMessages"]>(Prisma.sql`
    SELECT t.id::text AS id, encode(sha256(convert_to(to_jsonb(t)::text, 'UTF8')), 'hex') AS hash
    FROM ${migrationRelation(scope.schema, "messages")} t
    WHERE ${migrationIds(Prisma.sql`t."conversationId"`, scope.sourceConversationIds)}
      AND NOT (${migrationIds(Prisma.sql`t.id`, scope.messageIds)}) ORDER BY t.id
  `);
  return { ...data, sourceMessages, ...(await commentMigrationIntegrity(tx)) };
}
export async function insertCommentMigrationRows(
  tx: Prisma.TransactionClient,
  scope: CommentMigrationScope,
  table: MigrationTable,
  rows: MigrationRow[],
) {
  if (!rows.length) return;
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO ${migrationRelation(scope.schema, table)} SELECT * FROM
      jsonb_populate_recordset(NULL::${migrationRelation(scope.schema, table)}, ${JSON.stringify(rows)}::jsonb)
  `);
}
export function assertCommentMigrationJournal(value: AttachmentCommentMigrationJournal) {
  parseAttachmentCommentMigrationJournal(value);
}
