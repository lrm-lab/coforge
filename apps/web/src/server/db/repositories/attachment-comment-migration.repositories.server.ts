import { ATTACHMENT_COMMENT_MIGRATION_TRANSACTION_TIMEOUT_MS } from "#src/server/attachments/attachment-comment-migration.server";
import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import type {
  AttachmentCommentMigrationPlan,
  AttachmentCommentMigrationSnapshot,
  AttachmentCommentMigrationStore,
} from "#src/server/attachments/attachment-comment-migration.server";
import type {
  AttachmentCommentMigrationJournal,
  CommentMigrationScope,
} from "#src/server/attachments/attachment-comment-migration-journal.server";
import { inspectAttachmentCommentMigration } from "./attachment-comment-migration-inspection.repositories.server";
import {
  applyCommentMigrationToCopy,
  validateAppliedCommentMigration,
} from "./attachment-comment-migration-apply.repositories.server";
import { restoreCommentMigrationCopy } from "./attachment-comment-migration-restore.repositories.server";
import {
  captureCommentMigration,
  commentMigrationScope,
  migrationFingerprint,
  migrationIds,
  migrationRelation,
  assertCommentMigrationJournal,
} from "./attachment-comment-migration-journal.repositories.server";
import { unsupportedCommentMigrationDependencies } from "./attachment-comment-migration-dependencies.repositories.server";

type LocalCopy = { database: string; schema: string };
const transactionOptions = {
  isolationLevel: "Serializable",
  timeout: ATTACHMENT_COMMENT_MIGRATION_TRANSACTION_TIMEOUT_MS,
} as const;

async function lockCommentScope(tx: Prisma.TransactionClient, scope: CommentMigrationScope) {
  for (const [table, ids] of [
    ["conversations", scope.sourceConversationIds],
    ["attachments", scope.attachmentIds],
    ["conversations", scope.oldConversationIds],
  ] as const) {
    await tx.$queryRaw(Prisma.sql`SELECT id FROM ${migrationRelation(scope.schema, table)}
      WHERE ${migrationIds(Prisma.sql`id`, ids)} ORDER BY id FOR UPDATE`);
  }
}
async function assertNoUnsupportedDependencies(
  tx: Prisma.TransactionClient,
  scope: CommentMigrationScope,
  created: string[],
) {
  const dependencies = await unsupportedCommentMigrationDependencies(tx, {
    conversations: scope.oldConversationIds,
    sourceConversations: scope.sourceConversationIds,
    messages: scope.messageIds,
    members: [...scope.oldMemberIds, ...created],
    attachments: scope.attachmentIds,
  });
  if (dependencies.length)
    throw new Error("Local copy changed: unexpected dependency or new writes");
}
export class PrismaAttachmentCommentMigrationStore implements AttachmentCommentMigrationStore {
  constructor(
    private readonly db: PrismaClient,
    private readonly options: { localCopy?: LocalCopy } = {},
  ) {}

  inspect(): Promise<AttachmentCommentMigrationSnapshot> {
    return this.db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        return inspectAttachmentCommentMigration(tx);
      },
      {
        isolationLevel: "RepeatableRead",
        timeout: ATTACHMENT_COMMENT_MIGRATION_TRANSACTION_TIMEOUT_MS,
      },
    );
  }
  private async localCopyIdentity(tx: Prisma.TransactionClient): Promise<LocalCopy> {
    const expected = this.options.localCopy;
    if (!expected) throw new Error("Explicit local copy authorization is required");
    const [actual] = await tx.$queryRaw<
      LocalCopy[]
    >`SELECT current_database() AS database, current_schema() AS schema`;
    if (
      !actual ||
      actual.database !== expected.database ||
      actual.schema !== expected.schema ||
      !(
        actual.database.startsWith("coforge_attachment_rehearsal_") ||
        actual.schema.startsWith("attachment_rehearsal_")
      )
    ) {
      throw new Error("Database is not the authorized local copy");
    }
    return actual;
  }
  async applyToLocalCopy(
    makePlan: (snapshot: AttachmentCommentMigrationSnapshot) => AttachmentCommentMigrationPlan,
    persistJournal: (journal: AttachmentCommentMigrationJournal) => Promise<void>,
  ): Promise<AttachmentCommentMigrationJournal> {
    if (!this.options.localCopy) throw new Error("Explicit local copy authorization is required");
    return this.db.$transaction(async (tx) => {
      const identity = await this.localCopyIdentity(tx);
      const first = await inspectAttachmentCommentMigration(tx);
      if (makePlan(first).status !== "ready") throw new Error("Migration preflight is blocked");
      const scope = commentMigrationScope(first, identity);
      await lockCommentScope(tx, scope);
      const snapshot = await inspectAttachmentCommentMigration(tx);
      const plan = makePlan(snapshot);
      if (plan.status !== "ready") throw new Error("Migration preflight is blocked");
      if (
        migrationFingerprint(scope) !==
        migrationFingerprint(commentMigrationScope(snapshot, identity))
      )
        throw new Error("Local copy changed while acquiring locks");
      const before = await captureCommentMigration(tx, scope);
      const changes = await applyCommentMigrationToCopy(tx, scope, snapshot, plan, before);
      await assertNoUnsupportedDependencies(tx, scope, changes.createdMemberIds);
      const after = await captureCommentMigration(tx, scope);
      const journal: AttachmentCommentMigrationJournal = {
        version: 1,
        scope,
        plan,
        before,
        afterFingerprint: migrationFingerprint(after),
        ...changes,
      };
      validateAppliedCommentMigration(journal, after);
      // A failed/durable-backup write aborts the same transaction; no committed move loses its journal.
      await persistJournal(journal);
      return journal;
    }, transactionOptions);
  }
  async restoreLocalCopy(journal: AttachmentCommentMigrationJournal): Promise<void> {
    if (!this.options.localCopy) throw new Error("Explicit local copy authorization is required");
    assertCommentMigrationJournal(journal);
    await this.db.$transaction(async (tx) => {
      const identity = await this.localCopyIdentity(tx);
      if (identity.database !== journal.scope.database || identity.schema !== journal.scope.schema)
        throw new Error("Journal belongs to a different local copy");
      await lockCommentScope(tx, journal.scope);
      const current = await captureCommentMigration(tx, journal.scope);
      if (migrationFingerprint(current) === migrationFingerprint(journal.before)) return;
      if (migrationFingerprint(current) !== journal.afterFingerprint)
        throw new Error("Local copy changed: rollback cannot overwrite new writes");
      await assertNoUnsupportedDependencies(tx, journal.scope, journal.createdMemberIds);
      await restoreCommentMigrationCopy(tx, journal);
      const restored = await captureCommentMigration(tx, journal.scope);
      if (migrationFingerprint(restored) !== migrationFingerprint(journal.before))
        throw new Error("Rollback conservation check failed");
    }, transactionOptions);
  }
}
