import { expect, test } from "bun:test";
import { AppError } from "#src/lib/app-error";
import { AttachmentComments } from "#src/server/attachments/attachment-comments.server";
import { PrismaAttachmentCommentStore } from "#src/server/db/repositories/attachment-comments.repositories.server";
import { attachmentCommentsFixture } from "./helpers/attachment-comments-fixture";

// Replies live in their root comment's thread, and reactions (✅ among them) are written under the
// attachment's authority, like the comments themselves.
test("a reply joins its root comment's thread, counted on the root and listed under it", async () => {
  const f = await attachmentCommentsFixture();
  try {
    const comments = new AttachmentComments(new PrismaAttachmentCommentStore(f.db));
    const attachmentId = f.attachment.id;
    const root = await comments.post(f.actor, { attachmentId, body: "Root" });
    const first = await comments.post(f.actor, { attachmentId, body: "First", rootId: root.id });
    // A reply to a reply is one more reply to the same root comment.
    const second = await comments.post(
      { workspaceId: f.workspace.id, userId: f.member.id },
      { attachmentId, body: "Second", rootId: first.id },
    );
    expect(first.replyTarget).toBe(`attachment:${attachmentId}:${root.id}`);
    expect(second.replyTarget).toBe(first.replyTarget);

    const roots = await comments.list(f.actor, { attachmentId });
    expect(roots.comments.map((comment) => [comment.body, comment.replyCount])).toEqual([
      ["Root", 2],
    ]);
    const replies = await comments.list(f.actor, { attachmentId, rootId: root.id });
    expect(replies.comments.map((comment) => comment.body)).toEqual(["First", "Second"]);
    expect(replies.comments.map((comment) => comment.replyCount)).toEqual([0, 0]);
  } finally {
    await f.close();
  }
});

test("a reply has no place of its own and no root on another attachment", async () => {
  const f = await attachmentCommentsFixture();
  try {
    const comments = new AttachmentComments(new PrismaAttachmentCommentStore(f.db));
    const root = await comments.post(f.actor, { attachmentId: f.attachment.id, body: "Root" });
    await expect(
      comments.post(f.actor, {
        attachmentId: f.attachment.id,
        body: "Placed reply",
        rootId: root.id,
        anchor: { type: "lines", data: { start: 1, end: 1 } },
      }),
    ).rejects.toEqual(new AppError("INVALID_INPUT"));
    const other = await f.db.attachment.create({
      data: {
        workspaceId: f.workspace.id,
        conversationId: f.conversation.id,
        messageId: f.message.id,
        uploaderId: f.owner.id,
        objectKey: `test/comments/${crypto.randomUUID()}`,
        fileName: "other.txt",
        contentType: "text/plain",
        sizeBytes: 1,
      },
    });
    for (const rootId of [root.id, crypto.randomUUID()])
      await expect(
        comments.post(f.actor, { attachmentId: other.id, body: "Wrong root", rootId }),
      ).rejects.toEqual(new AppError("NOT_FOUND"));
    // The refused reply did not leave a discussion behind on the other attachment.
    expect((await comments.list(f.actor, { attachmentId: other.id })).conversationId).toBeNull();
  } finally {
    await f.close();
  }
});

test("✅ on a comment resolves it; taking back one's own ✅ is the reactor's alone", async () => {
  const f = await attachmentCommentsFixture();
  try {
    const comments = new AttachmentComments(new PrismaAttachmentCommentStore(f.db));
    const attachmentId = f.attachment.id;
    const member = { workspaceId: f.workspace.id, userId: f.member.id };
    const root = await comments.post(f.actor, { attachmentId, body: "Root" });
    const resolved = async () =>
      (await comments.list(f.actor, { attachmentId })).comments[0]!.resolved;

    // The member has not commented yet: reacting takes their seat in the discussion.
    const reacted = await comments.react(member, {
      attachmentId,
      messageId: root.id,
      emoji: "✅",
      active: true,
    });
    expect(reacted.reactions?.map((reaction) => [reaction.emoji, reaction.count])).toEqual([
      ["✅", 1],
    ]);
    expect(await resolved()).toBe(true);
    await comments.react(f.actor, { attachmentId, messageId: root.id, emoji: "✅", active: true });
    await comments.react(member, { attachmentId, messageId: root.id, emoji: "✅", active: false });
    expect(await resolved()).toBe(true);
    await comments.react(f.actor, { attachmentId, messageId: root.id, emoji: "✅", active: false });
    expect(await resolved()).toBe(false);

    const reply = await comments.post(f.actor, { attachmentId, body: "Reply", rootId: root.id });
    await comments.react(member, { attachmentId, messageId: reply.id, emoji: "👍", active: true });
    const [listed] = (await comments.list(f.actor, { attachmentId, rootId: root.id })).comments;
    expect(listed!.reactions?.map((reaction) => reaction.emoji)).toEqual(["👍"]);
  } finally {
    await f.close();
  }
});

test("a reaction needs the right to comment, a real emoji and a comment on this attachment", async () => {
  const f = await attachmentCommentsFixture();
  try {
    const comments = new AttachmentComments(new PrismaAttachmentCommentStore(f.db));
    const attachmentId = f.attachment.id;
    const root = await comments.post(f.actor, { attachmentId, body: "Root" });
    const react = { attachmentId, messageId: root.id, emoji: "✅", active: true };
    // The viewer reads the public channel's comments but is not a member who may write.
    await expect(
      comments.react({ workspaceId: f.workspace.id, userId: f.viewer.id }, react),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(
      comments.react({ workspaceId: f.workspace.id, userId: f.outsider.id }, react),
    ).rejects.toEqual(new AppError("NOT_FOUND"));
    await expect(comments.react(f.actor, { ...react, emoji: "not an emoji" })).rejects.toEqual(
      new AppError("INVALID_INPUT"),
    );
    // The source message is not a comment, though it carries the attachment.
    await expect(comments.react(f.actor, { ...react, messageId: f.message.id })).rejects.toEqual(
      new AppError("NOT_FOUND"),
    );
    expect((await comments.list(f.actor, { attachmentId })).comments[0]!.reactions ?? []).toEqual(
      [],
    );
  } finally {
    await f.close();
  }
});
