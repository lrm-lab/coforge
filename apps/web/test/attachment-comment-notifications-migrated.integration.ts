import { expect, test } from "bun:test";
import { ActivityInbox } from "#src/server/inbox/activity-inbox.server";
import {
  attachmentCommentsFixture,
  commentNoticesFor,
  commentPmaOf,
} from "./helpers/attachment-comments-fixture";

/**
 * Comment notifications after comment migration: comments live in the attachment's source
 * conversation as thread replies under its source message, and no `attachment_comment_threads`
 * row survives — reads, writes and notifications all detect through the `attachment_comments`
 * row itself.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */

const noticesFor = (f: Awaited<ReturnType<typeof attachmentCommentsFixture>>) =>
  commentNoticesFor(f);
const pmaOf = (f: Awaited<ReturnType<typeof attachmentCommentsFixture>>, messageId: string) =>
  commentPmaOf(f, messageId);

test("a comment living in the migrated source conversation still reads as an attachment comment", async () => {
  const f = await attachmentCommentsFixture();
  try {
    // The post-migration shape: the thread, the comment's Message, its attachmentComment row
    // and its notification all carry the source channel's id.
    await f.db.attachmentCommentThread.create({
      data: {
        attachmentId: f.attachment.id,
        workspaceId: f.workspace.id,
        conversationId: f.conversation.id,
      },
    });
    const sender = await f.db.conversationMember.findFirstOrThrow({
      where: { conversationId: f.conversation.id, userId: f.member.id },
    });
    const comment = await f.db.message.create({
      data: {
        conversationId: f.conversation.id,
        workspaceId: f.workspace.id,
        senderMemberId: sender.id,
        sequence: 2,
        body: "post-migration shape",
      },
    });
    await f.db.attachmentComment.create({
      data: {
        attachmentId: f.attachment.id,
        workspaceId: f.workspace.id,
        conversationId: f.conversation.id,
        messageId: comment.id,
      },
    });
    await f.db.pendingMentionAction.create({
      data: {
        messageId: comment.id,
        conversationId: f.conversation.id,
        workspaceId: f.workspace.id,
        senderMemberId: sender.id,
        targetUserId: f.owner.id,
        targetHandle: f.owner.username,
        expiresAt: new Date(Date.now() + 86_400_000),
        notifiedAt: comment.createdAt,
        reason: "subscribed",
      },
    });
    const inbox = new ActivityInbox(f.db, {});
    const items = await inbox.list(f.workspace.id, f.owner.id, { filter: "all" });
    const item = items.items.find((candidate) => candidate.mentionAction);
    expect(item?.latest.id).toBe(comment.id);
    expect(item?.attachmentComment).toMatchObject({
      attachmentId: f.attachment.id,
      fileName: "review.txt",
      sourceMessageId: f.message.id,
    });
  } finally {
    await f.close();
  }
});

test("a comment on a migrated attachment writes into its source conversation", async () => {
  // Once the migration's scope key stands, a thread-less attachment's comments live in the
  // attachment's source conversation as thread replies under its source message — `post()` may
  // not create a comment conversation there (the scope key forbids it).
  const f = await attachmentCommentsFixture();
  try {
    const { comments, notices } = noticesFor(f);
    // The deployment's post-migration state: the scope key replaces the threads key, so the
    // probe must be the only route to the source conversation — no thread row survives.
    const [legacy] = await f.db.$queryRaw<{ conname: string }[]>`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'attachment_comments'::regclass AND contype = 'f'
        AND pg_get_constraintdef(oid) LIKE '%attachment_comment_threads%'`;
    await f.db.$executeRawUnsafe(
      `ALTER TABLE "attachment_comments" DROP CONSTRAINT "${legacy!.conname}"`,
    );
    await f.db.$executeRaw`
      CREATE UNIQUE INDEX "attachments_comment_migration_scope_key"
      ON "attachments" (id, "workspaceId", "conversationId")`;
    await f.db.$executeRaw`
      ALTER TABLE "attachment_comments" ADD CONSTRAINT "attachment_comments_attachment_scope_fkey"
      FOREIGN KEY ("attachmentId", "workspaceId", "conversationId")
      REFERENCES "attachments" ("id", "workspaceId", "conversationId") NOT VALID`;
    try {
      const posted = await comments.post(
        { workspaceId: f.workspace.id, userId: f.member.id },
        { attachmentId: f.attachment.id, body: "after migration" },
        notices,
      );
      const message = await f.db.message.findUniqueOrThrow({
        where: { id: posted.id },
        select: { conversationId: true, threadRootId: true },
      });
      expect(message).toEqual({ conversationId: f.conversation.id, threadRootId: f.message.id });
      expect(
        await f.db.attachmentComment.findUniqueOrThrow({
          where: { messageId: posted.id },
          select: { conversationId: true },
        }),
      ).toEqual({ conversationId: f.conversation.id });
      // The uploader's notification and the comments listing both follow it there.
      expect(await pmaOf(f, posted.id)).toMatchObject([
        {
          targetUserId: f.owner.id,
          reason: "subscribed",
          conversationId: f.conversation.id,
        },
      ]);
      const inbox = new ActivityInbox(f.db, {});
      const items = await inbox.list(f.workspace.id, f.owner.id, { filter: "all" });
      expect(items.items.find((candidate) => candidate.attachmentComment)).toMatchObject({
        attachmentComment: { attachmentId: f.attachment.id },
      });
      // Nothing of the pre-migration shape may have been created.
      expect(
        await f.db.attachmentCommentThread.count({
          where: { attachmentId: f.attachment.id },
        }),
      ).toBe(0);
      expect(
        await f.db.conversation.count({
          where: { workspaceId: f.workspace.id, kind: "attachment_comments" },
        }),
      ).toBe(0);
    } finally {
      await f.db.$executeRaw`
        ALTER TABLE "attachment_comments"
        DROP CONSTRAINT IF EXISTS "attachment_comments_attachment_scope_fkey"`;
      await f.db.$executeRaw`DROP INDEX IF EXISTS "attachments_comment_migration_scope_key"`;
      await f.db.$executeRawUnsafe(
        `ALTER TABLE "attachment_comments" ADD CONSTRAINT "${legacy!.conname}"
        FOREIGN KEY ("attachmentId", "workspaceId", "conversationId")
        REFERENCES "attachment_comment_threads" ("attachmentId", "workspaceId", "conversationId")
        ON UPDATE CASCADE ON DELETE CASCADE NOT VALID`,
      );
    }
  } finally {
    await f.close();
  }
});
