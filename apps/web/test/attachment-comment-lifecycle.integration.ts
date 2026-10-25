import { expect, test } from "bun:test";
import { AttachmentComments } from "#src/server/attachments/attachment-comments.server";
import { PrismaAttachmentCommentStore } from "#src/server/db/repositories/attachment-comments.repositories.server";
import { deleteAttachmentRows } from "#src/server/db/repositories/attachment-deletion.repositories.server";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { writeReaction } from "#src/server/conversations/reaction-write.server";
import { attachmentCommentsFixture } from "./helpers/attachment-comments-fixture";

test("simultaneous first comments share one discussion and distinct ordered Messages", async () => {
  const f = await attachmentCommentsFixture();
  try {
    const comments = new AttachmentComments(new PrismaAttachmentCommentStore(f.db));
    const sent = await Promise.all([
      comments.post(f.actor, { attachmentId: f.attachment.id, body: "First review" }),
      comments.post(
        { workspaceId: f.workspace.id, userId: f.member.id },
        { attachmentId: f.attachment.id, body: "Another review" },
      ),
    ]);
    expect(new Set(sent.map((row) => row.id)).size).toBe(2);
    expect(sent.map((row) => row.sequence).sort()).toEqual([1, 2]);
    expect(
      await f.db.attachmentCommentThread.count({ where: { attachmentId: f.attachment.id } }),
    ).toBe(1);
    expect(await f.db.conversation.count({ where: { workspaceId: f.workspace.id } })).toBe(2);
    const page = await comments.list(f.actor, { attachmentId: f.attachment.id, limit: 1 });
    expect(page.hasOlder).toBe(true);
    expect(page.comments[0].sequence).toBe(2);
    const older = await comments.list(f.actor, {
      attachmentId: f.attachment.id,
      beforeSequence: 2,
      limit: 1,
    });
    expect(older.comments[0].sequence).toBe(1);
    expect(older.hasOlder).toBe(false);
  } finally {
    await f.close();
  }
});

test("completion derives from the ordinary checkmark reaction and unlinking keeps comments", async () => {
  const f = await attachmentCommentsFixture();
  try {
    const comments = new AttachmentComments(new PrismaAttachmentCommentStore(f.db));
    const sent = await comments.post(f.actor, {
      attachmentId: f.attachment.id,
      body: "Actionable review",
    });
    const stored = await f.db.message.findUniqueOrThrow({ where: { id: sent.id } });
    await writeReaction(f.db, undefined, {
      workspaceId: f.workspace.id,
      conversationId: stored.conversationId,
      messageId: sent.id,
      threadRootId: null,
      memberId: stored.senderMemberId!,
      emoji: "✅",
      active: true,
    });
    expect(
      (await comments.list(f.actor, { attachmentId: f.attachment.id })).comments[0].resolved,
    ).toBe(true);
    await writeReaction(f.db, undefined, {
      workspaceId: f.workspace.id,
      conversationId: stored.conversationId,
      messageId: sent.id,
      threadRootId: null,
      memberId: stored.senderMemberId!,
      emoji: "✅",
      active: false,
    });
    await f.db.attachment.update({ where: { id: f.attachment.id }, data: { messageId: null } });
    const retained = await comments.list(f.actor, { attachmentId: f.attachment.id });
    expect(retained.comments[0]).toMatchObject({ id: sent.id, resolved: false });
    await expect(
      comments.post(f.actor, { attachmentId: f.attachment.id, body: "  " }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      comments.post(f.actor, { attachmentId: f.attachment.id, body: "x".repeat(8001) }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  } finally {
    await f.close();
  }
});

test("deleting an uploader's attachment removes its dedicated discussion, messages and reactions", async () => {
  const f = await attachmentCommentsFixture();
  try {
    const comments = new AttachmentComments(new PrismaAttachmentCommentStore(f.db));
    const sent = await comments.post(f.actor, {
      attachmentId: f.attachment.id,
      body: "Delete with file",
    });
    const stored = await f.db.message.findUniqueOrThrow({ where: { id: sent.id } });
    await writeReaction(f.db, undefined, {
      workspaceId: f.workspace.id,
      conversationId: stored.conversationId,
      messageId: sent.id,
      threadRootId: null,
      memberId: stored.senderMemberId!,
      emoji: "✅",
      active: true,
    });
    await deleteAttachmentRows(f.db, { workspaceId: f.workspace.id, uploaderId: f.owner.id });
    expect(await f.db.attachment.count({ where: { id: f.attachment.id } })).toBe(0);
    expect(await f.db.conversation.count({ where: { id: stored.conversationId } })).toBe(0);
    expect(await f.db.message.count({ where: { id: sent.id } })).toBe(0);
    expect(await f.db.messageReaction.count({ where: { messageId: sent.id } })).toBe(0);
    expect(await f.db.conversation.count({ where: { id: f.conversation.id } })).toBe(1);
  } finally {
    await f.close();
  }
});

test("deleting the original channel removes attachment discussions in the same transaction", async () => {
  const f = await attachmentCommentsFixture();
  try {
    const comments = new AttachmentComments(new PrismaAttachmentCommentStore(f.db));
    const sent = await comments.post(f.actor, {
      attachmentId: f.attachment.id,
      body: "Delete with channel",
    });
    await new PublicChannels(f.db).deleteChannel(
      f.workspace.id,
      f.owner.id,
      f.conversation.id,
      async () => ({ removeMany: async () => {}, removePrefix: async () => {} }),
    );
    expect(await f.db.conversation.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
    expect(await f.db.message.count({ where: { id: sent.id } })).toBe(0);
  } finally {
    await f.close();
  }
});

test("a failed first-comment metadata write rolls back every new discussion row", async () => {
  const f = await attachmentCommentsFixture();
  const fault = `comment_failure_${crypto.randomUUID().replaceAll("-", "")}`;
  try {
    // Fixture-generated identifiers and UUID literal, never external input.
    await f.db.$executeRawUnsafe(
      `CREATE FUNCTION ${fault}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture comment failure'; END $$`,
    );
    await f.db.$executeRawUnsafe(
      `CREATE TRIGGER ${fault} BEFORE INSERT ON attachment_comments FOR EACH ROW WHEN (NEW."attachmentId" = '${f.attachment.id}'::uuid) EXECUTE FUNCTION ${fault}()`,
    );
    const comments = new AttachmentComments(new PrismaAttachmentCommentStore(f.db));
    await expect(
      comments.post(f.actor, { attachmentId: f.attachment.id, body: "Must roll back" }),
    ).rejects.toThrow("fixture comment failure");
    expect(await f.db.conversation.count({ where: { workspaceId: f.workspace.id } })).toBe(1);
    expect(
      await f.db.attachmentCommentThread.count({ where: { attachmentId: f.attachment.id } }),
    ).toBe(0);
    expect(await f.db.message.count({ where: { workspaceId: f.workspace.id } })).toBe(1);
    await f.db.$executeRawUnsafe(`DROP TRIGGER ${fault} ON attachment_comments`);
    await comments.post(f.actor, { attachmentId: f.attachment.id, body: "Retry after failure" });
    expect((await comments.list(f.actor, { attachmentId: f.attachment.id })).comments).toHaveLength(
      1,
    );
  } finally {
    await f.db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${fault} ON attachment_comments`);
    await f.db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${fault}()`);
    await f.close();
  }
});
