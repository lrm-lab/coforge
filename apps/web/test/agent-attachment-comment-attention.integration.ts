import { expect, test } from "bun:test";
import { AppBotInbox } from "#src/server/app-bots/app-bot-inbox.server";
import { unreadAgentMessagesFragment } from "#src/server/db/repositories/agent-attention.repositories.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { agentAttachmentMessagesFixture } from "./helpers/agent-attachment-messages-fixture";

test("reading comments never enrolls an Agent in human comment wake, mentions or Memory observation", async () => {
  const f = await agentAttachmentMessagesFixture();
  try {
    // A live Memory observer is the broadest channel recipient; a comment read must not enroll it.
    await f.db.workspaceMemoryAgent.create({ data: f.principal });
    await f.db.workspaceMemoryProfile.create({
      data: { workspaceId: f.workspace.id, desired: "openviking", observed: "ready" },
    });
    await f.comments.post(f.actor, { attachmentId: f.attachment.id, body: "First comment" });
    await f.messages.read(f.principal, f.target, { unread: true });
    const comment = await f.comments.post(f.actor, {
      attachmentId: f.attachment.id,
      body: `Please review <@agent:${f.principal.agentId}> @memory`,
    });
    const stored = await f.db.message.findUniqueOrThrow({ where: { id: comment.id } });
    const seat = await f.db.conversationMember.findUniqueOrThrow({
      where: {
        conversationId_agentId: {
          conversationId: stored.conversationId,
          agentId: f.principal.agentId,
        },
      },
    });
    expect(seat.leftAt).toBeNull();
    expect(await f.db.agentMessageDelivery.count({ where: { messageId: comment.id } })).toBe(0);
    expect(await f.db.messageMention.count({ where: { messageId: comment.id } })).toBe(0);
    expect(await f.db.pendingMentionAction.count({ where: { messageId: comment.id } })).toBe(0);
    expect(
      await f.db.admittedSegmentSourceMessage.count({ where: { messageId: comment.id } }),
    ).toBe(0);

    // Even an obsolete fanout record cannot make this private read seat an attention source.
    await f.db.agentMessageDelivery.create({
      data: {
        ...f.principal,
        conversationId: stored.conversationId,
        messageId: comment.id,
        sequence: comment.sequence,
      },
    });
    const repository = new PrismaDirectConversationRepository(f.db);
    const owed = await f.db.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM (${unreadAgentMessagesFragment(f.workspace.id, f.principal.agentId)}) owed`;
    expect(owed).toEqual([]);
    const recovery = await repository.readAgentRecoveryContext(f.workspace.id, f.principal.agentId);
    expect(recovery.resumeMessages).toEqual([]);
    expect(recovery.unreadSummary).toEqual({});
    expect(
      await repository.readPendingAgentDeliveries(f.workspace.id, f.principal.agentId),
    ).toEqual([]);
    expect((await new AppBotInbox(f.db).check(f.principal)).events).toEqual([]);
    expect((await f.messages.read(f.principal, f.target, { unread: true })).messages).toMatchObject(
      [{ id: comment.id }],
    );
  } finally {
    await f.close();
  }
});
