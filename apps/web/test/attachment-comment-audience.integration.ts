import { expect, test } from "bun:test";
import { AttachmentComments } from "#src/server/attachments/attachment-comments.server";
import { PrismaAttachmentCommentStore } from "#src/server/db/repositories/attachment-comments.repositories.server";
import { commentNotifier } from "#src/features/conversations/attachment-comment-audience";
import { attachmentCommentsFixture } from "./helpers/attachment-comments-fixture";

const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
const pgTest = connectionString ? test : test.skip;

pgTest("candidates are the file's own conversation's members who may read it", async () => {
  const f = await attachmentCommentsFixture();
  try {
    const comments = new AttachmentComments(new PrismaAttachmentCommentStore(f.db));
    await f.db.conversation.create({
      data: {
        workspaceId: f.workspace.id,
        channelName: "elsewhere",
        members: {
          create: [f.owner, f.viewer].map((user) => ({ userId: user.id })),
        },
      },
    });
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
    const reads = Object.fromEntries(audience.members.map((member) => [member.id, member.reads]));
    expect(reads).toEqual({
      [f.owner.id]: true,
      [f.member.id]: true,
      [f.outsider.id]: false,
    });
    expect(audience.subscribed).toEqual([{ kind: "user", id: f.owner.id, label: "owner" }]);
    expect(commentNotifier(audience)(`@${f.outsider.username} look`, [])).toEqual(["owner"]);
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
    let audience = await comments.audience(owner, f.attachment.id);
    expect(commentNotifier(audience)("first", [])).toEqual([]);
    await comments.post(owner, {
      attachmentId: f.attachment.id,
      body: "first",
    });
    await comments.post(member, {
      attachmentId: f.attachment.id,
      body: "second",
    });
    audience = await comments.audience(owner, f.attachment.id);
    expect(commentNotifier(audience)("third", [])).toEqual(["member"]);
    await f.db.conversationMember.updateMany({
      where: { conversationId: f.conversation.id, userId: f.member.id },
      data: { channelMuted: true, notificationLevel: "muted" },
    });
    audience = await comments.audience(owner, f.attachment.id);
    expect(commentNotifier(audience)("quiet", [])).toEqual([]);
    const body = `@${f.member.username} please look`;
    expect(commentNotifier(audience)(body, [])).toEqual(["member"]);
    const posted = await comments.post(owner, {
      attachmentId: f.attachment.id,
      body,
    });
    const notified = await f.db.pendingMentionAction.findMany({
      where: { messageId: posted.id },
    });
    expect(notified.map((row) => row.targetUserId)).toEqual([f.member.id]);
  } finally {
    await f.close();
  }
});

test("a bound mention stores the person's token, a mention row and a notification", async () => {
  const f = await attachmentCommentsFixture();
  try {
    const comments = new AttachmentComments(new PrismaAttachmentCommentStore(f.db));
    const bind = (user: { id: string; username: string }) => ({
      type: "user" as const,
      id: user.id,
      name: user.username,
    });
    const posted = await comments.post(f.actor, {
      attachmentId: f.attachment.id,
      body: `@${f.member.username} please check`,
      mentions: [bind(f.member)],
    });
    const stored = await f.db.message.findUniqueOrThrow({
      where: { id: posted.id },
      include: { mentions: true },
    });
    expect(stored.body).toBe(`<@human:${f.member.id}> please check`);
    expect(stored.mentions.map((row) => [row.kind, row.actorId])).toEqual([["user", f.member.id]]);
    const notified = await f.db.pendingMentionAction.findMany({
      where: { messageId: posted.id },
    });
    expect(notified.map((row) => [row.targetUserId, row.reason])).toEqual([
      [f.member.id, "mentioned"],
    ]);
    const outside = await comments.post(f.actor, {
      attachmentId: f.attachment.id,
      body: `@${f.viewer.username} hello`,
      mentions: [bind(f.viewer)],
    });
    expect(await f.db.messageMention.count({ where: { messageId: outside.id } })).toBe(0);
    expect(
      await f.db.pendingMentionAction.count({
        where: { messageId: outside.id },
      }),
    ).toBe(0);
  } finally {
    await f.close();
  }
});
