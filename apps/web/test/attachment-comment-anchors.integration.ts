import { expect, test } from "bun:test";
import type { AttachmentCommentAnchor } from "#src/features/conversations/attachment-comment-anchors";
import { AttachmentComments } from "#src/server/attachments/attachment-comments.server";
import { PrismaAttachmentCommentStore } from "#src/server/db/repositories/attachment-comments.repositories.server";
import { attachmentCommentsFixture } from "./helpers/attachment-comments-fixture";

// A comment on a place keeps its anchor through a fresh read, and only the place kind its file's
// preview offers is accepted.
test("each previewable kind stores its own anchor, read back on the comment", async () => {
  const f = await attachmentCommentsFixture();
  try {
    const comments = new AttachmentComments(new PrismaAttachmentCommentStore(f.db));
    const sibling = (fileName: string, contentType: string) =>
      f.db.attachment.create({
        data: {
          workspaceId: f.workspace.id,
          conversationId: f.conversation.id,
          messageId: f.message.id,
          uploaderId: f.owner.id,
          objectKey: `test/comments/${crypto.randomUUID()}`,
          fileName,
          contentType,
          sizeBytes: 1,
        },
      });
    const markdown = await sibling("guide.md", "text/markdown");
    const csv = await sibling("data.csv", "text/csv");
    const cases: [string, AttachmentCommentAnchor][] = [
      [f.attachment.id, { type: "lines", data: { start: 3, end: 5, quote: "three to five" } }],
      [markdown.id, { type: "md-section", data: { headingId: "setup", headingTitle: "Setup" } }],
      [csv.id, { type: "csv-rows", data: { start: 2, end: 2 } }],
    ];
    for (const [attachmentId, anchor] of cases) {
      const posted = await comments.post(f.actor, { attachmentId, body: "Here", anchor });
      expect(posted.anchor).toEqual(anchor);
      const listed = await comments.list(f.actor, { attachmentId });
      expect(listed.comments.map((comment) => comment.anchor)).toEqual([anchor]);
    }

    const whole = await comments.post(f.actor, { attachmentId: csv.id, body: "Whole file" });
    expect(whole.anchor).toBeNull();
  } finally {
    await f.close();
  }
});

test("an anchor of another file kind is refused and nothing is written", async () => {
  const f = await attachmentCommentsFixture();
  try {
    const comments = new AttachmentComments(new PrismaAttachmentCommentStore(f.db));
    await expect(
      comments.post(f.actor, {
        attachmentId: f.attachment.id,
        body: "Wrong kind",
        anchor: { type: "csv-rows", data: { start: 1, end: 1 } },
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect((await comments.list(f.actor, { attachmentId: f.attachment.id })).comments).toEqual([]);
  } finally {
    await f.close();
  }
});
