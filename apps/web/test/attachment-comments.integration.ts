import { expect, test } from "bun:test";
import { AttachmentComments } from "#src/server/attachments/attachment-comments.server";
import { PrismaAttachmentCommentStore } from "#src/server/db/repositories/attachment-comments.repositories.server";
import { attachmentCommentsFixture } from "./helpers/attachment-comments-fixture";

test("a whole-file comment uses ordinary persisted Messages and survives a new reader", async () => {
  const f = await attachmentCommentsFixture();
  try {
    const comments = new AttachmentComments(new PrismaAttachmentCommentStore(f.db));
    const input = { attachmentId: f.attachment.id };
    const empty = await comments.list(f.actor, input);
    expect(empty.comments).toEqual([]);
    expect(empty.threadTarget).toBe(`attachment:${f.attachment.id}`);
    expect(empty.canComment).toBe(true);
    expect(await f.db.attachmentCommentThread.count({ where: input })).toBe(0);
    const sent = await comments.post(f.actor, { ...input, body: "Review the whole file" });
    const reloaded = await new AttachmentComments(new PrismaAttachmentCommentStore(f.db)).list(
      f.actor,
      input,
    );
    expect(reloaded.comments).toHaveLength(1);
    expect(reloaded.comments[0]).toMatchObject({
      id: sent.id,
      body: "Review the whole file",
      anchor: null,
      resolved: false,
      senderName: f.owner.displayName,
      senderUserId: f.owner.id,
      replyTarget: `attachment:${f.attachment.id}:${sent.id}`,
    });
    const stored = await f.db.message.findUniqueOrThrow({ where: { id: sent.id } });
    expect(stored.conversationId).not.toBe(f.conversation.id);
    expect(stored.workspaceId).toBe(f.workspace.id);
    expect(stored.threadRootId).toBeNull();
    expect(
      await f.db.attachmentComment.count({
        where: { attachmentId: f.attachment.id, messageId: sent.id },
      }),
    ).toBe(1);
  } finally {
    await f.close();
  }
});
