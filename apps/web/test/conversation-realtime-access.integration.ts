import { expect, test } from "bun:test";
import { personConversationAccess } from "#src/server/conversations/channel-read-access.server";
import { attachmentCommentsFixture } from "./helpers/attachment-comments-fixture";

// Uses the channel fixture's real PostgreSQL records; no mocked query can authorize a viewer. The
// subscribe proxy holds a conversation channel for whoever this rule reads it for.
const reads = (
  db: Parameters<typeof personConversationAccess>[0],
  input: { workspaceId: string; conversationId: string; userId: string },
) =>
  personConversationAccess(db, input.userId, {
    id: input.conversationId,
    workspaceId: input.workspaceId,
  }).then((access) => access === "read");

test("typing subscriptions follow conversation read authority, including read-only channel viewers", async () => {
  const f = await attachmentCommentsFixture();
  try {
    const input = { workspaceId: f.workspace.id, conversationId: f.conversation.id };
    const authorize = (userId: string, workspaceId = f.workspace.id) =>
      reads(f.db, { ...input, workspaceId, userId });
    expect(await authorize(f.owner.id)).toBeTrue();
    // This Workspace member has never joined the channel and cannot post there.
    expect(await authorize(f.viewer.id)).toBeTrue();
    await f.db.conversationMember.update({
      where: { conversationId_userId: { conversationId: f.conversation.id, userId: f.member.id } },
      data: { leftAt: new Date() },
    });
    expect(await authorize(f.member.id)).toBeTrue();
    expect(await authorize(f.outsider.id)).toBeFalse();
    expect(await authorize(f.owner.id, crypto.randomUUID())).toBeFalse();
    await f.db.conversation.update({
      where: { id: f.conversation.id },
      data: { hiddenFromWorkspaceAt: new Date() },
    });
    expect(await authorize(f.owner.id)).toBeFalse();
    await f.db.conversation.update({
      where: { id: f.conversation.id },
      data: {
        hiddenFromWorkspaceAt: null,
        channelName: null,
        directKey: `user:${f.owner.id}|user:${f.member.id}`,
      },
    });
    expect(await authorize(f.owner.id)).toBeTrue();
    expect(await authorize(f.member.id)).toBeFalse();
    expect(await authorize(f.viewer.id)).toBeFalse();
    await f.db.workspaceMembership.delete({
      where: { workspaceId_userId: { workspaceId: f.workspace.id, userId: f.viewer.id } },
    });
    await f.db.conversation.update({
      where: { id: f.conversation.id },
      data: { channelName: "files", directKey: null },
    });
    expect(await authorize(f.viewer.id)).toBeFalse();
  } finally {
    await f.close();
  }
});

test("a private channel's subscriptions are its active members' only, a Workspace owner's too", async () => {
  const f = await attachmentCommentsFixture();
  try {
    const authorize = (userId: string) =>
      reads(f.db, {
        workspaceId: f.workspace.id,
        conversationId: f.conversation.id,
        userId,
      });
    await f.db.conversation.update({
      where: { id: f.conversation.id },
      data: { visibility: "private" },
    });
    expect(await authorize(f.member.id)).toBeTrue();
    // A Workspace member who never joined it, and one who left.
    expect(await authorize(f.viewer.id)).toBeFalse();
    await f.db.conversationMember.update({
      where: { conversationId_userId: { conversationId: f.conversation.id, userId: f.member.id } },
      data: { leftAt: new Date() },
    });
    expect(await authorize(f.member.id)).toBeFalse();
    // The Workspace's owner, once out of it, is refused like anyone else.
    expect(await authorize(f.owner.id)).toBeTrue();
    await f.db.conversationMember.update({
      where: { conversationId_userId: { conversationId: f.conversation.id, userId: f.owner.id } },
      data: { leftAt: new Date() },
    });
    expect(await authorize(f.owner.id)).toBeFalse();
  } finally {
    await f.close();
  }
});
