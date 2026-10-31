import { expect, test } from "bun:test";
import { AttachmentComments } from "#src/server/attachments/attachment-comments.server";
import { PrismaAttachmentCommentStore } from "#src/server/db/repositories/attachment-comments.repositories.server";
import { commentNotifier } from "#src/features/conversations/attachment-comment-audience";
import { attachmentCommentsFixture } from "./helpers/attachment-comments-fixture";

/**
 * Whom a comment can @ and whom it will notify, as the comment field reads them: by attachment id,
 * from the file's own conversation and by the rules a posted comment is held to, whatever page the
 * file is shown on.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */

const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
const pgTest = connectionString ? test : test.skip;

pgTest("candidates are the file's own conversation's members who may read it", async () => {
  const f = await attachmentCommentsFixture();
  try {
    const comments = new AttachmentComments(new PrismaAttachmentCommentStore(f.db));
    // The viewer shares another channel with the owner; that channel never decides.
    await f.db.conversation.create({
      data: {
        workspaceId: f.workspace.id,
        channelName: "elsewhere",
        members: { create: [f.owner, f.viewer].map((user) => ({ userId: user.id })) },
      },
    });
    // A seat on the file's channel without Workspace membership reads nothing.
    await f.db.conversationMember.create({
      data: {
        workspaceId: f.workspace.id,
        conversationId: f.conversation.id,
        userId: f.outsider.id,
      },
    });
    const audience = await comments.audience(
      { workspaceId: f.workspace.id, userId: f.member.id },
      f.attachment.id,
    );
    expect(audience.viewerId).toBe(f.member.id);
    // Every active member of the file's channel resolves a mention; only readers are notified.
    const reads = Object.fromEntries(audience.members.map((member) => [member.id, member.reads]));
    expect(reads).toEqual({ [f.owner.id]: true, [f.member.id]: true, [f.outsider.id]: false });
    // The uploader is notified before anyone is named; naming a member who cannot read adds no one.
    expect(audience.subscribed).toEqual([{ kind: "user", id: f.owner.id, label: "owner" }]);
    expect(commentNotifier(audience)(`@${f.outsider.username} look`, [])).toEqual(["owner"]);
    // Someone who cannot read the file is told nothing about who can.
    await expect(
      comments.audience({ workspaceId: f.workspace.id, userId: f.outsider.id }, f.attachment.id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  } finally {
    await f.close();
  }
});

pgTest("will-notify matches whom a posted comment notifies", async () => {
  const f = await attachmentCommentsFixture();
  try {
    const comments = new AttachmentComments(new PrismaAttachmentCommentStore(f.db));
    const owner = { workspaceId: f.workspace.id, userId: f.owner.id };
    const member = { workspaceId: f.workspace.id, userId: f.member.id };
    // The uploader alone: their own comment notifies no one.
    let audience = await comments.audience(owner, f.attachment.id);
    expect(commentNotifier(audience)("first", [])).toEqual([]);
    await comments.post(owner, { attachmentId: f.attachment.id, body: "first" });
    // A commenter is notified from then on; the author never is.
    await comments.post(member, { attachmentId: f.attachment.id, body: "second" });
    audience = await comments.audience(owner, f.attachment.id);
    expect(commentNotifier(audience)("third", [])).toEqual(["member"]);
    // A muted channel keeps a subscriber asleep, but a mention wakes them.
    await f.db.conversationMember.updateMany({
      where: { conversationId: f.conversation.id, userId: f.member.id },
      data: { channelMuted: true },
    });
    audience = await comments.audience(owner, f.attachment.id);
    expect(commentNotifier(audience)("quiet", [])).toEqual([]);
    const body = `@${f.member.username} please look`;
    expect(commentNotifier(audience)(body, [])).toEqual(["member"]);
    const posted = await comments.post(owner, { attachmentId: f.attachment.id, body });
    const notified = await f.db.pendingMentionAction.findMany({ where: { messageId: posted.id } });
    expect(notified.map((row) => row.targetUserId)).toEqual([f.member.id]);
  } finally {
    await f.close();
  }
});
