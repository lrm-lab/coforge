import { expect, test } from "bun:test";
import { AppError } from "#src/lib/app-error";
import { AttachmentComments } from "#src/server/attachments/attachment-comments.server";
import { PrismaAttachmentCommentStore } from "#src/server/db/repositories/attachment-comments.repositories.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { ConversationHistory } from "#src/server/conversations/conversation-history.server";
import {
  saveUserMessage,
  listUserSavedMessages,
} from "#src/server/conversations/saved-messages.server";
import { searchMessages } from "#src/server/conversations/message-search.server";
import { personConversationAccess } from "#src/server/conversations/channel-read-access.server";
import { attachmentCommentsFixture } from "./helpers/attachment-comments-fixture";

test("comment reads follow source visibility, while only current source members can write", async () => {
  const f = await attachmentCommentsFixture();
  try {
    const comments = new AttachmentComments(new PrismaAttachmentCommentStore(f.db));
    const input = { attachmentId: f.attachment.id };
    await comments.post(f.actor, { ...input, body: "Keep my review" });
    const viewer = { workspaceId: f.workspace.id, userId: f.viewer.id };
    expect(await comments.list(viewer, input)).toMatchObject({
      canComment: false,
      disabledReason: "not-member",
    });
    await expect(comments.post(viewer, { ...input, body: "Cannot write" })).rejects.toMatchObject({
      code: "ACCESS_DENIED",
    });
    await expect(comments.list({ ...viewer, userId: f.outsider.id }, input)).rejects.toEqual(
      new AppError("NOT_FOUND"),
    );
    await expect(comments.list({ ...f.actor, workspaceId: f.outsider.id }, input)).rejects.toEqual(
      new AppError("NOT_FOUND"),
    );
    await f.db.conversation.update({
      where: { id: f.conversation.id },
      data: { archivedAt: new Date() },
    });
    expect(await comments.list(f.actor, input)).toMatchObject({
      canComment: false,
      disabledReason: "archived",
    });
    await expect(comments.post(f.actor, { ...input, body: "Archived" })).rejects.toMatchObject({
      code: "ACCESS_DENIED",
    });
    await f.db.conversation.update({
      where: { id: f.conversation.id },
      data: { archivedAt: null },
    });
    await f.db.conversationMember.update({
      where: { conversationId_userId: { conversationId: f.conversation.id, userId: f.owner.id } },
      data: { leftAt: new Date() },
    });
    expect(await comments.list(f.actor, input)).toMatchObject({
      canComment: false,
      disabledReason: "not-member",
    });
    await expect(
      comments.post(f.actor, { ...input, body: "Stale comment member" }),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await f.db.conversation.update({
      where: { id: f.conversation.id },
      data: { hiddenFromWorkspaceAt: new Date() },
    });
    await expect(comments.list(f.actor, input)).rejects.toEqual(new AppError("NOT_FOUND"));
  } finally {
    await f.close();
  }
});

test("generic read, search and subscription never authorize through comment membership", async () => {
  const f = await attachmentCommentsFixture();
  try {
    const comments = new AttachmentComments(new PrismaAttachmentCommentStore(f.db));
    const sent = await comments.post(f.actor, {
      attachmentId: f.attachment.id,
      body: "Confidential comment",
    });
    const stored = await f.db.message.findUniqueOrThrow({ where: { id: sent.id } });
    await expect(
      new ConversationHistory(f.db).authorize(f.workspace.id, f.owner.id, stored.conversationId),
    ).rejects.toEqual(new AppError("ACCESS_DENIED"));
    const page = await searchMessages(f.db, {
      workspaceId: f.workspace.id,
      userId: f.owner.id,
      query: "Confidential comment",
      sort: "recent",
      limit: 20,
      offset: 0,
    });
    expect(page.results).toEqual([]);
    // Nor may the subscribe proxy hold the comment conversation's channel for them.
    expect(
      await personConversationAccess(f.db, f.actor.userId, {
        id: stored.conversationId,
        workspaceId: f.actor.workspaceId,
      }),
    ).not.toBe("read");
  } finally {
    await f.close();
  }
});

test("Agent comment authority also follows source membership, never its comment seat", async () => {
  const f = await attachmentCommentsFixture();
  try {
    const agent = await f.db.agent.create({
      data: {
        workspaceId: f.workspace.id,
        ownerId: f.owner.id,
        name: "reviewer",
        displayName: "Reviewer",
        runtimeConfig: {},
      },
    });
    await f.db.conversationMember.create({
      data: { workspaceId: f.workspace.id, conversationId: f.conversation.id, agentId: agent.id },
    });
    const actor = { workspaceId: f.workspace.id, agentId: agent.id };
    const comments = new AttachmentComments(new PrismaAttachmentCommentStore(f.db));
    const sent = await comments.post(actor, {
      attachmentId: f.attachment.id,
      body: "Agent review",
    });
    const stored = await f.db.message.findUniqueOrThrow({ where: { id: sent.id } });
    const repository = new PrismaDirectConversationRepository(f.db);
    for (const anchor of [crypto.randomUUID(), sent.id])
      await expect(
        repository.setAgentMessageReaction(f.workspace.id, agent.id, anchor, "✅", true),
      ).rejects.toThrow("message not found or not visible to this Agent");
    await expect(
      repository.resolveAgentMessage(f.workspace.id, agent.id, sent.id),
    ).rejects.toThrow();
    expect(
      (await repository.searchMessages(f.workspace.id, agent.id, { sort: "recent" })).messages.some(
        (row) => row.id === sent.id,
      ),
    ).toBe(false);
    await f.db.conversationMember.update({
      where: { conversationId_agentId: { conversationId: f.conversation.id, agentId: agent.id } },
      data: { leftAt: new Date() },
    });
    await expect(comments.list(actor, { attachmentId: f.attachment.id })).rejects.toEqual(
      new AppError("NOT_FOUND"),
    );
    expect(
      await f.db.conversationMember.count({
        where: { conversationId: stored.conversationId, agentId: agent.id },
      }),
    ).toBe(1);
  } finally {
    await f.close();
  }
});

test("the generic Saved API cannot retain a comment through its author seat", async () => {
  const f = await attachmentCommentsFixture();
  try {
    const sent = await new AttachmentComments(new PrismaAttachmentCommentStore(f.db)).post(
      f.actor,
      { attachmentId: f.attachment.id, body: "Private saved review" },
    );
    const stored = await f.db.message.findUniqueOrThrow({ where: { id: sent.id } });
    await expect(
      saveUserMessage(f.db, {
        ...f.actor,
        conversationId: stored.conversationId,
        messageId: sent.id,
      }),
    ).rejects.toThrow();
    await f.db.savedMessage.create({
      data: {
        workspaceId: f.workspace.id,
        conversationId: stored.conversationId,
        messageId: sent.id,
        memberId: stored.senderMemberId!,
      },
    });
    expect(await listUserSavedMessages(f.db, f.actor)).toEqual([]);
  } finally {
    await f.close();
  }
});

test("private attachment discussions and app-event read-only state follow their original conversation", async () => {
  const f = await attachmentCommentsFixture();
  try {
    await f.db.conversation.update({
      where: { id: f.conversation.id },
      data: { channelName: null, directKey: `user:${f.owner.id}|user:${f.member.id}` },
    });
    const comments = new AttachmentComments(new PrismaAttachmentCommentStore(f.db));
    const input = { attachmentId: f.attachment.id };
    await comments.post(f.actor, { ...input, body: "Private review" });
    await expect(
      comments.list({ workspaceId: f.workspace.id, userId: f.viewer.id }, input),
    ).rejects.toEqual(new AppError("NOT_FOUND"));
    await f.db.conversation.update({
      where: { id: f.conversation.id },
      data: { kind: "app_events" },
    });
    expect(await comments.list(f.actor, input)).toMatchObject({
      canComment: false,
      disabledReason: "read-only",
    });
    await expect(
      comments.post(f.actor, { ...input, body: "Read-only source" }),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  } finally {
    await f.close();
  }
});

test("an image in a task discussion is read and commented by whoever can read the task's board", async () => {
  const f = await attachmentCommentsFixture();
  try {
    // A task on the channel board, with its own discussion conversation; the file moves into
    // the discussion, as an attachment on a task reply does.
    const creatorMemberId = f.conversation.members.find((row) => row.userId === f.owner.id)!.id;
    const discussion = await f.db.conversation.create({
      data: {
        workspaceId: f.workspace.id,
        kind: "task_thread",
        members: { create: [{ userId: f.owner.id }] },
      },
      include: { members: true },
    });
    await f.db.task.create({
      data: {
        workspaceId: f.workspace.id,
        conversationId: f.conversation.id,
        number: 1,
        title: "Ship it",
        creatorMemberId,
        discussionConversationId: discussion.id,
      },
    });
    // The file sits on a reply in the discussion, as a task-reply attachment does.
    const reply = await f.db.message.create({
      data: {
        workspaceId: f.workspace.id,
        conversationId: discussion.id,
        body: "See the mock",
        sequence: 1,
        senderMemberId: discussion.members[0]!.id,
      },
    });
    await f.db.attachment.update({
      where: { id: f.attachment.id },
      data: { conversationId: discussion.id, messageId: reply.id },
    });

    const comments = new AttachmentComments(new PrismaAttachmentCommentStore(f.db));
    const input = { attachmentId: f.attachment.id };
    // A board member reads the comments and may comment: the discussion is not read-only just
    // because it is a task thread (the regression this fixes).
    expect(await comments.list(f.actor, input)).toMatchObject({
      canComment: true,
      disabledReason: null,
    });
    const posted = await comments.post(f.actor, { ...input, body: "On the task image" });
    expect(posted.id).toBeTruthy();
    // A Workspace member who is not on the board reads it only while the board is public, as for
    // any channel image: a public board lets them read but not comment.
    const viewer = { workspaceId: f.workspace.id, userId: f.viewer.id };
    expect(await comments.list(viewer, input)).toMatchObject({
      canComment: false,
      disabledReason: "not-member",
    });
    // A private board hides the image's comments — count and all — from a non-member.
    await f.db.conversation.update({
      where: { id: f.conversation.id },
      data: { visibility: "private" },
    });
    await expect(comments.list(viewer, input)).rejects.toEqual(new AppError("NOT_FOUND"));
    // The board member still reads and comments.
    expect(await comments.list(f.actor, input)).toMatchObject({ canComment: true });
  } finally {
    await f.close();
  }
});

test("a comment author seat cannot authorize an ordinary attachment upload", async () => {
  const f = await attachmentCommentsFixture();
  try {
    const sent = await new AttachmentComments(new PrismaAttachmentCommentStore(f.db)).post(
      f.actor,
      { attachmentId: f.attachment.id, body: "Author seat only" },
    );
    const stored = await f.db.message.findUniqueOrThrow({ where: { id: sent.id } });
    const { storeAttachment } = await import("#src/server/attachments/attachment.server");
    let storageOpened = false;
    for (const conversationId of [crypto.randomUUID(), stored.conversationId])
      await expect(
        storeAttachment(
          f.db,
          { userId: f.owner.id, conversationId, file: new File(["bytes"], "nested.txt") },
          async () => {
            storageOpened = true;
            throw new Error("Comment seats must not open ordinary upload storage");
          },
        ),
      ).rejects.toEqual(new AppError("ACCESS_DENIED"));
    expect(storageOpened).toBe(false);
  } finally {
    await f.close();
  }
});
