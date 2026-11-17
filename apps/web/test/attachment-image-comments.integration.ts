import { expect, test } from "bun:test";
import { activityOpenTarget } from "#src/features/inbox/activity-open-target";
import { AttachmentComments } from "#src/server/attachments/attachment-comments.server";
import { PrismaAttachmentCommentStore } from "#src/server/db/repositories/attachment-comments.repositories.server";
import { ActivityInbox } from "#src/server/inbox/activity-inbox.server";
import { attachmentCommentsFixture } from "./helpers/attachment-comments-fixture";
import { isConversation } from "./helpers/activity-inbox-fixture";

/**
 * An image's comments are the file comments every attachment has: a member's comment on an image
 * is an Activity item for its uploader that names the file and opens the image at that comment,
 * and a reply opens at the comment it answers. Never one for the author.
 *
 * Needs `CHANNEL_TEST_DATABASE_URL` (the fixture throws without it).
 */

test("a comment on an image is an Activity item that opens the image at that comment", async () => {
  const f = await attachmentCommentsFixture();
  try {
    await f.db.attachment.update({
      where: { id: f.attachment.id },
      data: { fileName: "chart.png", contentType: "image/png" },
    });
    const comments = new AttachmentComments(new PrismaAttachmentCommentStore(f.db));
    const peer = { workspaceId: f.workspace.id, userId: f.member.id };
    const comment = await comments.post(peer, {
      attachmentId: f.attachment.id,
      body: "Fixed in the next export",
    });
    const inbox = new ActivityInbox(f.db, {});
    const itemOf = async (userId: string) =>
      (await inbox.list(f.workspace.id, userId, { filter: "all" })).items
        .filter(isConversation)
        .find((candidate) => candidate.attachmentComment);
    // A comment that starts no thread still names the file it is on.
    const item = await itemOf(f.owner.id);
    expect(item?.attachmentComment).toMatchObject({
      attachmentId: f.attachment.id,
      fileName: "chart.png",
      threadRootId: null,
    });
    expect(activityOpenTarget(item!)).toEqual({
      kind: "channel",
      id: f.conversation.id,
      messageId: f.message.id,
      attachmentId: f.attachment.id,
      commentId: comment.id,
    });
    // The author is told nothing about their own comment.
    expect(await itemOf(f.member.id)).toBeUndefined();
    // A reply to it, once the uploader has answered, opens at the root comment it answers.
    const reply = await comments.post(f.actor, {
      attachmentId: f.attachment.id,
      body: "Thanks",
      rootId: comment.id,
    });
    const answered = await itemOf(f.member.id);
    expect(answered?.attachmentComment?.threadRootId).toBe(comment.id);
    expect(activityOpenTarget(answered!)).toMatchObject({
      attachmentId: f.attachment.id,
      commentId: comment.id,
    });
    expect(reply.id).not.toBe(comment.id);
  } finally {
    await f.close();
  }
});
