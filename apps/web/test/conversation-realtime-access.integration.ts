import { expect, test } from "bun:test";
import { AppError } from "#src/lib/app-error";
import { authorizeConversationRealtime } from "#src/server/conversations/conversation-realtime-access.server";
import { attachmentCommentsFixture } from "./helpers/attachment-comments-fixture";

// Uses the channel fixture's real PostgreSQL records; no mocked query can authorize a viewer.
test("typing subscriptions follow conversation read authority, including read-only channel viewers", async () => {
  const f = await attachmentCommentsFixture();
  try {
    const input = { workspaceId: f.workspace.id, conversationId: f.conversation.id };
    const authorize = (userId: string, workspaceId = f.workspace.id) =>
      authorizeConversationRealtime(f.db, { ...input, workspaceId, userId });
    expect(await authorize(f.owner.id)).toBe(f.conversation.id);
    // This Workspace member has never joined the channel and cannot post there.
    expect(await authorize(f.viewer.id)).toBe(f.conversation.id);
    await f.db.conversationMember.update({
      where: { conversationId_userId: { conversationId: f.conversation.id, userId: f.member.id } },
      data: { leftAt: new Date() },
    });
    expect(await authorize(f.member.id)).toBe(f.conversation.id);
    await expect(authorize(f.outsider.id)).rejects.toEqual(new AppError("ACCESS_DENIED"));
    await expect(authorize(f.owner.id, crypto.randomUUID())).rejects.toEqual(
      new AppError("ACCESS_DENIED"),
    );
    await f.db.conversation.update({
      where: { id: f.conversation.id },
      data: { hiddenFromWorkspaceAt: new Date() },
    });
    await expect(authorize(f.owner.id)).rejects.toEqual(new AppError("ACCESS_DENIED"));
    await f.db.conversation.update({
      where: { id: f.conversation.id },
      data: {
        hiddenFromWorkspaceAt: null,
        channelName: null,
        directKey: `user:${f.owner.id}|user:${f.member.id}`,
      },
    });
    expect(await authorize(f.owner.id)).toBe(f.conversation.id);
    await expect(authorize(f.member.id)).rejects.toEqual(new AppError("ACCESS_DENIED"));
    await expect(authorize(f.viewer.id)).rejects.toEqual(new AppError("ACCESS_DENIED"));
    await f.db.workspaceMembership.delete({
      where: { workspaceId_userId: { workspaceId: f.workspace.id, userId: f.viewer.id } },
    });
    await f.db.conversation.update({
      where: { id: f.conversation.id },
      data: { channelName: "files", directKey: null },
    });
    await expect(authorize(f.viewer.id)).rejects.toEqual(new AppError("ACCESS_DENIED"));
  } finally {
    await f.close();
  }
});

test("a private channel's subscriptions are its active members' only, a Workspace owner's too", async () => {
  const f = await attachmentCommentsFixture();
  try {
    const authorize = (userId: string) =>
      authorizeConversationRealtime(f.db, {
        workspaceId: f.workspace.id,
        conversationId: f.conversation.id,
        userId,
      });
    await f.db.conversation.update({
      where: { id: f.conversation.id },
      data: { visibility: "private" },
    });
    expect(await authorize(f.member.id)).toBe(f.conversation.id);
    // A Workspace member who never joined it, and one who left.
    await expect(authorize(f.viewer.id)).rejects.toEqual(new AppError("ACCESS_DENIED"));
    await f.db.conversationMember.update({
      where: { conversationId_userId: { conversationId: f.conversation.id, userId: f.member.id } },
      data: { leftAt: new Date() },
    });
    await expect(authorize(f.member.id)).rejects.toEqual(new AppError("ACCESS_DENIED"));
    // The Workspace's owner, once out of it, is refused like anyone else.
    expect(await authorize(f.owner.id)).toBe(f.conversation.id);
    await f.db.conversationMember.update({
      where: { conversationId_userId: { conversationId: f.conversation.id, userId: f.owner.id } },
      data: { leftAt: new Date() },
    });
    await expect(authorize(f.owner.id)).rejects.toEqual(new AppError("ACCESS_DENIED"));
  } finally {
    await f.close();
  }
});
