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
import { authorizeConversationRealtime } from "#src/server/conversations/conversation-realtime-access.server";
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
      new AppError("ACCESS_DENIED"),
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
    await expect(comments.list(f.actor, input)).rejects.toEqual(new AppError("ACCESS_DENIED"));
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
    await expect(
      authorizeConversationRealtime(f.db, { ...f.actor, conversationId: stored.conversationId }),
    ).rejects.toEqual(new AppError("ACCESS_DENIED"));
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
      new AppError("ACCESS_DENIED"),
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
    ).rejects.toEqual(new AppError("ACCESS_DENIED"));
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
