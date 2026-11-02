import { expect, test } from "bun:test";
import { AttachmentComments } from "#src/server/attachments/attachment-comments.server";
import { attachmentCommentCounts } from "#src/server/conversations/conversation-history.server";
import { PrismaAttachmentCommentStore } from "#src/server/db/repositories/attachment-comments.repositories.server";
import { attachmentCommentsFixture } from "./helpers/attachment-comments-fixture";

/**
 * A file card's comment count (task #238), against real PostgreSQL: every comment on each listed
 * attachment, replies included, and no row for a file without any.
 */
test("each attachment's comment count, replies included", async () => {
  const f = await attachmentCommentsFixture();
  try {
    const comments = new AttachmentComments(new PrismaAttachmentCommentStore(f.db));
    const first = await comments.post(f.actor, { attachmentId: f.attachment.id, body: "One" });
    await comments.post(f.actor, { attachmentId: f.attachment.id, body: "Two" });
    await comments.post(f.actor, {
      attachmentId: f.attachment.id,
      body: "A reply",
      rootId: first.id,
    });
    const quiet = await f.db.attachment.create({
      data: {
        workspaceId: f.workspace.id,
        conversationId: f.conversation.id,
        messageId: f.message.id,
        uploaderId: f.owner.id,
        objectKey: `test/comments/quiet-${crypto.randomUUID()}`,
        fileName: "quiet.txt",
        contentType: "text/plain",
        sizeBytes: 1,
      },
    });

    const counts = await attachmentCommentCounts(f.db, [
      { attachments: [{ id: f.attachment.id }, { id: quiet.id }] },
    ]);
    expect(Object.fromEntries(counts)).toEqual({ [f.attachment.id]: 3 });
    expect((await attachmentCommentCounts(f.db, [{ attachments: [] }])).size).toBe(0);
  } finally {
    await f.close();
  }
});
