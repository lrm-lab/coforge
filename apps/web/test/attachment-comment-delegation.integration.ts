import { expect, test } from "bun:test";
import { AppError } from "#src/lib/app-error";
import { AttachmentComments } from "#src/server/attachments/attachment-comments.server";
import { PrismaAttachmentCommentStore } from "#src/server/db/repositories/attachment-comments.repositories.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { unreadAgentMessagesFragment } from "#src/server/db/repositories/agent-attention.repositories.server";
import { AppBotInbox } from "#src/server/app-bots/app-bot-inbox.server";
import { WorkspaceAssistants } from "#src/server/agents/workspace-assistants.server";
import { WorkspaceAssistantCommands } from "#src/server/agents/workspace-assistant-commands.server";
import { toggleUserMessageReaction } from "#src/server/conversations/user-message-reactions.server";
import { attachmentCommentsFixture } from "./helpers/attachment-comments-fixture";

for (const surface of ["attention", "recovery", "pending-deliveries", "app-bot-inbox"] as const) {
  test(`${surface} excludes comments after their Agent author loses source access`, async () => {
    const f = await attachmentCommentsFixture();
    try {
      const agent = await f.db.agent.create({
        data: {
          workspaceId: f.workspace.id,
          ownerId: f.owner.id,
          name: "reviewer",
          displayName: "Reviewer",
          runtimeConfig: {},
          ...(surface === "app-bot-inbox" ? { systemKind: "app-bot" } : {}),
        },
      });
      const scope = { workspaceId: f.workspace.id, agentId: agent.id };
      await f.db.conversationMember.create({
        data: { ...scope, conversationId: f.conversation.id },
      });
      const comments = new AttachmentComments(new PrismaAttachmentCommentStore(f.db));
      await comments.post(scope, { attachmentId: f.attachment.id, body: "Agent review" });
      const reply = await comments.post(f.actor, {
        attachmentId: f.attachment.id,
        body: "Private reply",
      });
      const message = await f.db.message.findUniqueOrThrow({ where: { id: reply.id } });
      // Even a stale delivery must never turn a comment into ordinary Agent attention.
      await f.db.agentMessageDelivery.create({
        data: {
          ...scope,
          conversationId: message.conversationId,
          messageId: reply.id,
          sequence: reply.sequence,
        },
      });
      await f.db.conversationMember.update({
        where: { conversationId_agentId: { conversationId: f.conversation.id, agentId: agent.id } },
        data: { leftAt: new Date() },
      });
      const repository = new PrismaDirectConversationRepository(f.db);
      if (surface === "attention") {
        const rows = await f.db.$queryRaw<
          { id: string }[]
        >`SELECT "id" FROM (${unreadAgentMessagesFragment(f.workspace.id, agent.id)}) owed`;
        expect(rows).toEqual([]);
      } else if (surface === "recovery") {
        const result = await repository.readAgentRecoveryContext(f.workspace.id, agent.id);
        expect(result.resumeMessages).toEqual([]);
        expect(result.unreadSummary).toEqual({});
      } else if (surface === "pending-deliveries") {
        expect(await repository.readPendingAgentDeliveries(f.workspace.id, agent.id)).toEqual([]);
      } else {
        expect((await new AppBotInbox(f.db).check(scope)).events).toEqual([]);
      }
    } finally {
      await f.close();
    }
  });
}

for (const surface of ["assistant-resolve", "reaction"] as const) {
  test(`${surface} cannot use a human comment author seat`, async () => {
    const f = await attachmentCommentsFixture();
    try {
      if (surface === "assistant-resolve") {
        const peer = await f.db.agent.create({
          data: {
            workspaceId: f.workspace.id,
            ownerId: f.owner.id,
            name: "comment-peer",
            displayName: "Comment peer",
            runtimeConfig: {},
          },
        });
        await f.db.conversationMember.create({
          data: {
            workspaceId: f.workspace.id,
            conversationId: f.conversation.id,
            agentId: peer.id,
          },
        });
        await new AttachmentComments(new PrismaAttachmentCommentStore(f.db)).post(
          { workspaceId: f.workspace.id, agentId: peer.id },
          { attachmentId: f.attachment.id, body: "Agent comment" },
        );
      }
      const sent = await new AttachmentComments(new PrismaAttachmentCommentStore(f.db)).post(
        f.actor,
        {
          attachmentId: f.attachment.id,
          body: "Private file comment",
        },
      );
      const stored = await f.db.message.findUniqueOrThrow({ where: { id: sent.id } });
      if (surface === "assistant-resolve") {
        const assistant = await new WorkspaceAssistants(f.db).ensure(f.workspace.id, f.owner.id);
        await expect(
          new WorkspaceAssistantCommands(f.db).resolve(
            { workspaceId: f.workspace.id, agentId: assistant.agentId },
            sent.id,
          ),
        ).rejects.toEqual(new AppError("NOT_FOUND"));
      } else {
        for (const messageId of [crypto.randomUUID(), sent.id])
          await expect(
            toggleUserMessageReaction(f.db, undefined, {
              ...f.actor,
              conversationId: stored.conversationId,
              messageId,
              emoji: "✅",
              active: true,
            }),
          ).rejects.toEqual(new AppError("NOT_FOUND"));
      }
    } finally {
      await f.close();
    }
  });
}

test("DM comment access follows the peer Agent's current visibility and active status", async () => {
  const f = await attachmentCommentsFixture();
  try {
    const agent = await f.db.agent.create({
      data: {
        workspaceId: f.workspace.id,
        ownerId: f.member.id,
        name: "peer",
        displayName: "Peer",
        visibility: "public",
        runtimeConfig: {},
      },
    });
    await f.db.conversation.update({
      where: { id: f.conversation.id },
      data: {
        channelName: null,
        directKey: `agent:${agent.id}|user:${f.owner.id}`,
      },
    });
    await f.db.conversationMember.create({
      data: {
        workspaceId: f.workspace.id,
        conversationId: f.conversation.id,
        agentId: agent.id,
      },
    });
    const comments = new AttachmentComments(new PrismaAttachmentCommentStore(f.db));
    const input = { attachmentId: f.attachment.id };
    await comments.post(f.actor, { ...input, body: "Visible peer" });
    for (const data of [
      { visibility: "private" },
      { visibility: "public", deletedAt: new Date() },
    ]) {
      await f.db.agent.update({ where: { id: agent.id }, data });
      await expect(comments.list(f.actor, input)).rejects.toEqual(new AppError("NOT_FOUND"));
      await expect(comments.post(f.actor, { ...input, body: "Forbidden" })).rejects.toEqual(
        new AppError("NOT_FOUND"),
      );
    }
  } finally {
    await f.close();
  }
});

test("a returning comment author reactivates its author seat", async () => {
  const f = await attachmentCommentsFixture();
  try {
    const comments = new AttachmentComments(new PrismaAttachmentCommentStore(f.db));
    const first = await comments.post(f.actor, { attachmentId: f.attachment.id, body: "First" });
    const stored = await f.db.message.findUniqueOrThrow({ where: { id: first.id } });
    await f.db.conversationMember.update({
      where: { id: stored.senderMemberId! },
      data: { leftAt: new Date() },
    });
    await comments.post(f.actor, { attachmentId: f.attachment.id, body: "Returned" });
    expect(
      (await f.db.conversationMember.findUniqueOrThrow({ where: { id: stored.senderMemberId! } }))
        .leftAt,
    ).toBeNull();
  } finally {
    await f.close();
  }
});
