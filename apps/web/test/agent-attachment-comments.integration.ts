import { expect, test } from "bun:test";
import { AppError } from "#src/lib/app-error";
import { readAgentAttachmentComments } from "#src/server/attachments/agent-attachment-comments.server";
import { AttachmentComments } from "#src/server/attachments/attachment-comments.server";
import { PrismaAttachmentCommentStore } from "#src/server/db/repositories/attachment-comments.repositories.server";
import { attachmentCommentsFixture } from "./helpers/attachment-comments-fixture";

async function agentIn(f: Awaited<ReturnType<typeof attachmentCommentsFixture>>, member: boolean) {
  const agent = await f.db.agent.create({
    data: {
      workspaceId: f.workspace.id,
      ownerId: f.owner.id,
      name: `reviewer-${crypto.randomUUID().slice(0, 8)}`,
      displayName: "Reviewer",
      runtimeConfig: {},
    },
  });
  if (member)
    await f.db.conversationMember.create({
      data: { workspaceId: f.workspace.id, agentId: agent.id, conversationId: f.conversation.id },
    });
  return { workspaceId: f.workspace.id, agentId: agent.id };
}

test("an Agent in the source conversation reads comments oldest first, with anchors and ✅", async () => {
  const f = await attachmentCommentsFixture();
  try {
    const principal = await agentIn(f, true);
    const comments = new AttachmentComments(new PrismaAttachmentCommentStore(f.db));
    const attachmentId = f.attachment.id;
    expect(await readAgentAttachmentComments(f.db, principal, { attachmentId })).toMatchObject({
      comments: [],
      hasOlder: false,
    });
    // Reading never creates the discussion.
    expect(await f.db.attachmentCommentThread.count({ where: { attachmentId } })).toBe(0);
    const first = await comments.post(f.actor, { attachmentId, body: "first" });
    await comments.post(f.actor, { attachmentId, body: "second" });
    await comments.post(f.actor, { attachmentId, body: "third" });
    await f.db.attachmentComment.update({
      where: { messageId: first.id },
      data: { anchorType: "lines", anchorData: { start: 3, end: 5 } },
    });
    const stored = await f.db.message.findUniqueOrThrow({ where: { id: first.id } });
    await f.db.messageReaction.create({
      data: {
        workspaceId: f.workspace.id,
        conversationId: stored.conversationId,
        messageId: first.id,
        memberId: stored.senderMemberId!,
        emoji: "✅",
      },
    });
    const all = await readAgentAttachmentComments(f.db, principal, { attachmentId });
    expect(all.comments.map((c) => c.body)).toEqual(["first", "second", "third"]);
    expect(all.comments[0]).toMatchObject({
      senderKind: "human",
      anchor: { type: "lines", data: { start: 3, end: 5 } },
      resolved: true,
    });
    expect(all.comments[1]!.resolved).toBe(false);
    const latest = await readAgentAttachmentComments(f.db, principal, { attachmentId, limit: 2 });
    expect(latest.comments.map((c) => c.body)).toEqual(["second", "third"]);
    expect(latest.hasOlder).toBe(true);
    const older = await readAgentAttachmentComments(f.db, principal, {
      attachmentId,
      before: latest.comments[0]!.sequence,
    });
    expect(older.comments.map((c) => c.body)).toEqual(["first"]);
    expect(older.hasOlder).toBe(false);
  } finally {
    await f.close();
  }
});

test("an Agent outside the source conversation, or in another Workspace, finds nothing", async () => {
  const f = await attachmentCommentsFixture();
  try {
    await new AttachmentComments(new PrismaAttachmentCommentStore(f.db)).post(f.actor, {
      attachmentId: f.attachment.id,
      body: "private",
    });
    const outsider = await agentIn(f, false);
    await expect(
      readAgentAttachmentComments(f.db, outsider, { attachmentId: f.attachment.id }),
    ).rejects.toBeInstanceOf(AppError);
    const stranger = { ...(await agentIn(f, true)), workspaceId: crypto.randomUUID() };
    await expect(
      readAgentAttachmentComments(f.db, stranger, { attachmentId: f.attachment.id }),
    ).rejects.toBeInstanceOf(AppError);
  } finally {
    await f.close();
  }
});
