import { Prisma } from "#src/generated/prisma/client";
import type {
  CommentMigrationIntegrity,
  CommentMigrationScope,
} from "#src/server/attachments/attachment-comment-migration-journal.server";
import {
  migrationIdentifier,
  migrationRelation,
  type MigrationTable,
} from "./attachment-comment-migration-journal.repositories.server";

export const commentMigrationAttachmentIndex = "attachments_comment_migration_scope_key";
export const commentMigrationAttachmentForeignKey = "attachment_comments_attachment_scope_fkey";

function originalMetadataKey(integrity: CommentMigrationIntegrity) {
  const keys = integrity.constraints.filter(
    (row) =>
      row.kind === "f" &&
      row.table === "attachment_comments" &&
      row.target === "attachment_comment_threads",
  );
  const key = keys[0];
  const columns = '("attachmentId", "workspaceId", "conversationId")';
  if (
    keys.length !== 1 ||
    !key ||
    !key.validated ||
    !key.definition.startsWith(`FOREIGN KEY ${columns} REFERENCES `) ||
    !key.definition.includes(`attachment_comment_threads${columns}`) ||
    !key.definition.includes("ON UPDATE CASCADE ON DELETE CASCADE")
  ) {
    throw new Error("Unsupported legacy attachment metadata constraint");
  }
  return key;
}
const memberAndMessageKeys = (integrity: CommentMigrationIntegrity) =>
  integrity.constraints.filter(
    (row) =>
      row.kind === "f" && (row.target === "messages" || row.target === "conversation_members"),
  );

/** Change only the audited message/member FK checks; never disable database integrity. */
export async function deferCommentMigrationKeys(
  tx: Prisma.TransactionClient,
  scope: CommentMigrationScope,
  integrity: CommentMigrationIntegrity,
) {
  for (const key of memberAndMessageKeys(integrity)) {
    if (!key.validated) throw new Error("Unvalidated migration foreign key");
    await tx.$executeRaw(Prisma.sql`ALTER TABLE ${migrationRelation(scope.schema, key.table as MigrationTable)}
      ALTER CONSTRAINT ${migrationIdentifier(key.name)} DEFERRABLE INITIALLY DEFERRED`);
    await tx.$executeRaw(
      Prisma.sql`SET CONSTRAINTS ${migrationIdentifier(scope.schema)}.${migrationIdentifier(key.name)} DEFERRED`,
    );
  }
}
export async function finishCommentMigrationKeys(
  tx: Prisma.TransactionClient,
  scope: CommentMigrationScope,
  integrity: CommentMigrationIntegrity,
) {
  await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
  for (const key of memberAndMessageKeys(integrity)) {
    const mode = key.deferrable
      ? key.deferred
        ? Prisma.sql`DEFERRABLE INITIALLY DEFERRED`
        : Prisma.sql`DEFERRABLE INITIALLY IMMEDIATE`
      : Prisma.sql`NOT DEFERRABLE`;
    await tx.$executeRaw(Prisma.sql`ALTER TABLE ${migrationRelation(scope.schema, key.table as MigrationTable)}
      ALTER CONSTRAINT ${migrationIdentifier(key.name)} ${mode}`);
  }
}
export async function dropLegacyCommentMetadataKey(
  tx: Prisma.TransactionClient,
  scope: CommentMigrationScope,
  before: CommentMigrationIntegrity,
) {
  const key = originalMetadataKey(before);
  await tx.$executeRaw(
    Prisma.sql`ALTER TABLE ${migrationRelation(scope.schema, "attachment_comments")} DROP CONSTRAINT ${migrationIdentifier(key.name)}`,
  );
}
export async function addOrdinaryCommentMetadataKey(
  tx: Prisma.TransactionClient,
  scope: CommentMigrationScope,
  before: CommentMigrationIntegrity,
) {
  let createdIndex = false;
  const existing = before.indexes.find((row) => row.name === commentMigrationAttachmentIndex);
  if (
    existing &&
    (!existing.definition.startsWith("CREATE UNIQUE INDEX ") ||
      !existing.definition.includes('(id, "workspaceId", "conversationId")'))
  )
    throw new Error("Unexpected migration index definition");
  if (!existing) {
    await tx.$executeRaw(Prisma.sql`CREATE UNIQUE INDEX ${migrationIdentifier(commentMigrationAttachmentIndex)}
      ON ${migrationRelation(scope.schema, "attachments")} (id, "workspaceId", "conversationId")`);
    createdIndex = true;
  }
  // Adding after all rows move validates every row immediately, without NOT VALID.
  await tx.$executeRaw(Prisma.sql`ALTER TABLE ${migrationRelation(scope.schema, "attachment_comments")}
    ADD CONSTRAINT ${migrationIdentifier(commentMigrationAttachmentForeignKey)}
    FOREIGN KEY ("attachmentId", "workspaceId", "conversationId")
    REFERENCES ${migrationRelation(scope.schema, "attachments")} (id, "workspaceId", "conversationId")
    ON UPDATE CASCADE ON DELETE CASCADE`);
  return createdIndex;
}
export async function dropOrdinaryCommentMetadataKey(
  tx: Prisma.TransactionClient,
  scope: CommentMigrationScope,
) {
  await tx.$executeRaw(Prisma.sql`ALTER TABLE ${migrationRelation(scope.schema, "attachment_comments")}
    DROP CONSTRAINT ${migrationIdentifier(commentMigrationAttachmentForeignKey)}`);
}
export async function restoreLegacyCommentMetadataKey(
  tx: Prisma.TransactionClient,
  scope: CommentMigrationScope,
  before: CommentMigrationIntegrity,
  createdIndex: boolean,
) {
  const key = originalMetadataKey(before);
  const mode = key.deferrable
    ? key.deferred
      ? Prisma.sql`DEFERRABLE INITIALLY DEFERRED`
      : Prisma.sql`DEFERRABLE INITIALLY IMMEDIATE`
    : Prisma.sql`NOT DEFERRABLE`;
  await tx.$executeRaw(Prisma.sql`ALTER TABLE ${migrationRelation(scope.schema, "attachment_comments")}
    ADD CONSTRAINT ${migrationIdentifier(key.name)} FOREIGN KEY ("attachmentId", "workspaceId", "conversationId")
    REFERENCES ${migrationRelation(scope.schema, "attachment_comment_threads")} ("attachmentId", "workspaceId", "conversationId")
    ON UPDATE CASCADE ON DELETE CASCADE ${mode}`);
  if (createdIndex)
    await tx.$executeRaw(
      Prisma.sql`DROP INDEX ${migrationIdentifier(scope.schema)}.${migrationIdentifier(commentMigrationAttachmentIndex)}`,
    );
}
