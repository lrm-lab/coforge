import type { AttachmentCommentMigrationJournal } from "./attachment-comment-migration-journal.server";
import {
  planAttachmentCommentMigration,
  type AttachmentCommentMigrationSnapshot,
  type AttachmentCommentMigrationPlan,
} from "./attachment-comment-migration-plan.server";

export type {
  AttachmentCommentMigrationPlan,
  AttachmentCommentMigrationSnapshot,
} from "./attachment-comment-migration-plan.server";

export const ATTACHMENT_COMMENT_MIGRATION_TRANSACTION_TIMEOUT_MS = 30_000;

export interface AttachmentCommentMigrationStore {
  inspect(): Promise<AttachmentCommentMigrationSnapshot>;
  applyToLocalCopy(
    plan: (snapshot: AttachmentCommentMigrationSnapshot) => AttachmentCommentMigrationPlan,
    persistJournal: (journal: AttachmentCommentMigrationJournal) => Promise<void>,
  ): Promise<AttachmentCommentMigrationJournal>;
  restoreLocalCopy(journal: AttachmentCommentMigrationJournal): Promise<void>;
}

/** Maintenance only: ordinary attachment reads and writes never enter this workflow. */
export class AttachmentCommentMigration {
  constructor(private readonly store: AttachmentCommentMigrationStore) {}

  async preflight() {
    return planAttachmentCommentMigration(await this.store.inspect());
  }

  applyToLocalCopy(options: {
    persistJournal: (journal: AttachmentCommentMigrationJournal) => Promise<void>;
  }) {
    return this.store.applyToLocalCopy(planAttachmentCommentMigration, options.persistJournal);
  }

  restoreLocalCopy(journal: AttachmentCommentMigrationJournal) {
    return this.store.restoreLocalCopy(journal);
  }

  async rehearseLocalCopy(options: {
    persistJournal: (journal: AttachmentCommentMigrationJournal) => Promise<void>;
  }) {
    const journal = await this.applyToLocalCopy(options);
    await this.restoreLocalCopy(journal);
    return { status: "restored" as const, plan: journal.plan };
  }
}
