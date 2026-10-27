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
    const sibling = (fileName: string, contentType: string, sizeBytes = 1) =>
      f.db.attachment.create({
        data: {
          workspaceId: f.workspace.id,
          conversationId: f.conversation.id,
          messageId: f.message.id,
          uploaderId: f.owner.id,
          objectKey: `test/comments/${crypto.randomUUID()}`,
          fileName,
          contentType,
          sizeBytes,
        },
      });
    const markdown = await sibling("guide.md", "text/markdown");
    const csv = await sibling("data.csv", "text/csv");
    const html = await sibling("page.html", "text/html");
    const cases: [string, AttachmentCommentAnchor][] = [
      [f.attachment.id, { type: "lines", data: { start: 3, end: 5, quote: "three to five" } }],
      [markdown.id, { type: "md-section", data: { headingId: "setup", headingTitle: "Setup" } }],
      [csv.id, { type: "csv-rows", data: { start: 2, end: 2 } }],
      [
        html.id,
        {
          type: "html-region",
          data: {
            x: 40,
            y: 1200,
            w: 0,
            h: 0,
            viewportWidth: 900,
            documentWidth: 900,
            documentHeight: 4000,
            quote: "Pricing",
          },
        },
      ],
    ];
    for (const [attachmentId, anchor] of cases) {
      const posted = await comments.post(f.actor, { attachmentId, body: "Here", anchor });
      expect(posted.anchor).toEqual(anchor);
      const listed = await comments.list(f.actor, { attachmentId });
      expect(listed.comments.map((comment) => comment.anchor)).toEqual([anchor]);
    }

    const whole = await comments.post(f.actor, { attachmentId: csv.id, body: "Whole file" });
    expect(whole.anchor).toBeNull();

    // A 164 KB report, past the old 64 KB Markdown bound, takes a section comment now.
    const report = await sibling("report.md", "text/markdown", 164 * 1024);
    const section = {
      type: "md-section" as const,
      data: { headingId: "summary", headingTitle: "Summary" },
    };
    expect(
      (
        await comments.post(f.actor, {
          attachmentId: report.id,
          body: "This section",
          anchor: section,
        })
      ).anchor,
    ).toEqual(section);

    // A PDF takes comments by its type; a ZIP has no preview, lists none, and takes none.
    const pdf = await sibling("brief.pdf", "application/pdf");
    expect(
      (await comments.post(f.actor, { attachmentId: pdf.id, body: "Brief" })).anchor,
    ).toBeNull();
    const zip = await sibling("bundle.zip", "application/zip");
    expect(await comments.list(f.actor, { attachmentId: zip.id })).toMatchObject({
      canComment: false,
      canReact: true,
    });
    await expect(
      comments.post(f.actor, { attachmentId: zip.id, body: "Zip" }),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED", errorId: "attachment-comments-no-preview" });

    // A log past the 5 MB preview has no preview, so it takes no comments at all.
    const large = await sibling("server.log", "text/plain", 5 * 1024 * 1024 + 1);
    for (const anchor of [{ type: "lines" as const, data: { start: 1, end: 1 } }, undefined])
      await expect(
        comments.post(f.actor, { attachmentId: large.id, body: "Here", anchor }),
      ).rejects.toMatchObject({ code: "ACCESS_DENIED", errorId: "attachment-comments-no-preview" });
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
    // A text file takes no region either: only an HTML preview draws one.
    await expect(
      comments.post(f.actor, {
        attachmentId: f.attachment.id,
        body: "Wrong kind",
        anchor: {
          type: "html-region",
          data: { x: 0, y: 0, w: 5, h: 5, viewportWidth: 1, documentWidth: 1, documentHeight: 1 },
        },
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect((await comments.list(f.actor, { attachmentId: f.attachment.id })).comments).toEqual([]);
  } finally {
    await f.close();
  }
});
