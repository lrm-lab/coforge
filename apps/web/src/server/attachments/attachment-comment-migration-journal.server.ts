import { z } from "zod";
import type { AttachmentCommentMigrationPlan } from "./attachment-comment-migration-plan.server";

export const COMMENT_MIGRATION_TABLES = [
  "conversations",
  "conversation_members",
  "messages",
  "attachments",
  "attachment_comments",
  "attachment_comment_threads",
  "message_reactions",
  "message_mentions",
  "saved_messages",
  "thread_reads",
  "thread_follows",
  "workspace_assistant_read_cursors",
] as const;
const id = z.uuid();
const sequence = z.number().int().min(0).max(2_147_483_647);
const count = z.number().int().min(0);
const rows = z.array(z.record(z.string(), z.unknown()));
const scope = z
  .object({
    database: z.string().min(1),
    schema: z.string().min(1),
    oldConversationIds: z.array(id),
    sourceConversationIds: z.array(id),
    attachmentIds: z.array(id),
    messageIds: z.array(id),
    oldMemberIds: z.array(id),
  })
  .strict();
const integrity = z.object({
  constraints: z.array(
    z
      .object({
        table: z.enum(COMMENT_MIGRATION_TABLES),
        name: z.string().min(1),
        kind: z.string().length(1),
        target: z.string().nullable(),
        definition: z.string(),
        deferrable: z.boolean(),
        deferred: z.boolean(),
        validated: z.boolean(),
      })
      .strict(),
  ),
  indexes: z.array(z.object({ name: z.string(), definition: z.string() }).strict()),
});
const backup = integrity
  .extend({
    conversations: rows,
    members: rows,
    messages: rows,
    attachments: rows,
    comments: rows,
    threads: rows,
    reactions: rows,
    mentions: rows,
    saved: rows,
    reads: rows,
    follows: rows,
    assistantCursors: rows,
    sourceMessages: z.array(z.object({ id, hash: z.string().regex(/^[a-f0-9]{64}$/u) }).strict()),
  })
  .strict();
const plan: z.ZodType<AttachmentCommentMigrationPlan> = z
  .object({
    status: z.enum(["ready", "blocked"]),
    counts: z
      .object({ attachments: count, messages: count, reactions: count, historicalSeats: count })
      .strict(),
    blockers: z.array(
      z
        .object({
          code: z.string(),
          attachmentId: id.optional(),
          conversationId: id.optional(),
          schema: z.string().optional(),
          table: z.string().optional(),
          constraint: z.string().optional(),
          count: count.optional(),
        })
        .strict(),
    ),
    moves: z.array(
      z.object({ messageId: id, conversationId: id, threadRootId: id, sequence }).strict(),
    ),
    memberMappings: z.array(
      z
        .object({
          fromMemberId: id,
          conversationId: id,
          targetMemberId: id.nullable(),
          userId: id.nullable(),
          agentId: id.nullable(),
          createInactive: z.boolean(),
        })
        .strict(),
    ),
    threadReadMappings: z.array(
      z
        .object({
          memberId: id,
          conversationId: id,
          rootMessageId: id,
          readThroughSequence: sequence,
          doneThroughSequence: sequence.nullable(),
          reunreadMessages: count,
        })
        .strict(),
    ),
    assistantReadMappings: z.array(
      z
        .object({
          sessionId: id,
          conversationId: id,
          scope: id,
          readThroughSequence: sequence,
          reunreadMessages: count,
        })
        .strict(),
    ),
  })
  .strict();
const journal = z
  .object({
    version: z.literal(1),
    scope,
    plan,
    before: backup,
    afterFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    resolvedMembers: z.array(z.object({ fromMemberId: id, targetMemberId: id }).strict()),
    createdMemberIds: z.array(id),
    createdAttachmentIndex: z.boolean(),
  })
  .strict()
  .refine((value) => value.plan.status === "ready");

export type MigrationRow = Record<string, unknown>;
export type CommentMigrationScope = z.infer<typeof scope>;
export type CommentMigrationIntegrity = z.infer<typeof integrity>;
export type CommentMigrationBackup = z.infer<typeof backup>;
/** Private backup, never a Web response or a public migration report. */
export type AttachmentCommentMigrationJournal = z.infer<typeof journal>;

export function parseAttachmentCommentMigrationJournal(
  value: unknown,
): AttachmentCommentMigrationJournal {
  const result = journal.safeParse(value);
  if (!result.success) throw new Error("Invalid local copy migration journal");
  return result.data;
}
