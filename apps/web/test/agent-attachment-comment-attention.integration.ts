import { expect, test } from "bun:test";
import { AppBotInbox } from "#src/server/app-bots/app-bot-inbox.server";
import { unreadAgentMessagesFragment } from "#src/server/db/repositories/agent-attention.repositories.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { agentAttachmentMessagesFixture } from "./helpers/agent-attachment-messages-fixture";

test("an Agent reads comments without enrollment, and a comment that mentions it notifies it", async () => {
  const f = await agentAttachmentMessagesFixture();
  try {
    // A live Memory observer is the broadest channel recipient; a comment read must not enroll it.
    await f.db.workspaceMemoryAgent.create({ data: f.principal });
    await f.db.workspaceMemoryProfile.create({
      data: { workspaceId: f.workspace.id, desired: "openviking", observed: "ready" },
    });
    const first = await f.comments.post(f.actor, {
      attachmentId: f.attachment.id,
      body: "First comment",
    });
    await f.messages.read(f.principal, f.target, { unread: true });
    // An ordinary comment notifies only its prior participants: the uploader is the author here,
    // so nobody is notified and no Agent delivery exists.
    expect(await f.db.agentMessageDelivery.count({ where: { messageId: first.id } })).toBe(0);
    expect(await f.db.pendingMentionAction.count({ where: { messageId: first.id } })).toBe(0);
    expect(await f.db.admittedSegmentSourceMessage.count({ where: { messageId: first.id } })).toBe(
      0,
    );

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
    // A typed `<@agent:…>` token and a bare `@memory` name no member: neither resolves, so the
    // read seat stays a seat and nothing fans out.
    expect(await f.db.messageMention.count({ where: { messageId: comment.id } })).toBe(0);
    expect(await f.db.agentMessageDelivery.count({ where: { messageId: comment.id } })).toBe(0);
    expect(await f.db.pendingMentionAction.count({ where: { messageId: comment.id } })).toBe(0);
    expect(
      await f.db.admittedSegmentSourceMessage.count({ where: { messageId: comment.id } }),
    ).toBe(0);
  } finally {
    await f.close();
  }
});

test("a comment that mentions an Agent delivers to it and reads as its attention", async () => {
  const f = await agentAttachmentMessagesFixture();
  try {
    const agentName = (
      await f.db.agent.findUniqueOrThrow({
        where: { id: f.principal.agentId },
        select: { name: true },
      })
    ).name;
    const comment = await f.comments.post(f.actor, {
      attachmentId: f.attachment.id,
      body: `Please review @${agentName}`,
    });
    const stored = await f.db.message.findUniqueOrThrow({ where: { id: comment.id } });
    // The resolved mention: a seat in the comment conversation, a MessageMention row, and a
    // delivery that says why it reached the Agent.
    const seat = await f.db.conversationMember.findUniqueOrThrow({
      where: {
        conversationId_agentId: {
          conversationId: stored.conversationId,
          agentId: f.principal.agentId,
        },
      },
    });
    expect(seat.leftAt).toBeNull();
    const mention = await f.db.messageMention.findFirstOrThrow({
      where: { messageId: comment.id },
    });
    expect(mention).toMatchObject({
      kind: "agent",
      actorId: f.principal.agentId,
      memberId: seat.id,
    });
    const delivery = await f.db.agentMessageDelivery.findFirstOrThrow({
      where: { messageId: comment.id, agentId: f.principal.agentId },
    });
    expect(delivery.reason).toBe("mentioned");
    expect(delivery.receivedAt).toBeNull();
    // People outside the comment are notified through mention rows only, so no pending action.
    expect(await f.db.pendingMentionAction.count({ where: { messageId: comment.id } })).toBe(0);

    // It counts for catch-up reads: unread, recovery and pending deliveries all see it.
    const owed = await f.db.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM (${unreadAgentMessagesFragment(f.workspace.id, f.principal.agentId)}) owed`;
    expect(owed).toEqual([{ id: comment.id }]);
    const repository = new PrismaDirectConversationRepository(f.db);
    const recovery = await repository.readAgentRecoveryContext(f.workspace.id, f.principal.agentId);
    expect(recovery.unreadSummary).toEqual({ [`attachment:${f.attachment.id}`]: 1 });
    expect(recovery.resumeMessages).toMatchObject([
      { messageId: comment.id, target: `attachment:${f.attachment.id}` },
    ]);
    const pending = await repository.readPendingAgentDeliveries(
      f.workspace.id,
      f.principal.agentId,
    );
    expect(pending).toMatchObject([
      { deliveryId: delivery.deliveryId, target: `attachment:${f.attachment.id}` },
    ]);
    // A bot-style inbox check sees the same delivery event the daemon push carried.
    expect((await new AppBotInbox(f.db).check(f.principal)).events).toMatchObject([
      { id: comment.id, target: `attachment:${f.attachment.id}` },
    ]);
    expect((await f.messages.read(f.principal, f.target, { unread: true })).messages).toMatchObject(
      [{ id: comment.id }],
    );
  } finally {
    await f.close();
  }
});

test("a delivery stops replaying once the Agent loses the attachment's source conversation", async () => {
  const f = await agentAttachmentMessagesFixture();
  try {
    // The Agent comments first, so the owner's next comment notifies it as a prior commenter —
    // and it holds a seat in the comment conversation. The stale seat must never stand in for
    // the source membership the delivery actually authorizes through.
    await f.comments.post(
      { workspaceId: f.workspace.id, agentId: f.principal.agentId },
      { attachmentId: f.attachment.id, body: "agent pass" },
    );
    const comment = await f.comments.post(f.actor, {
      attachmentId: f.attachment.id,
      body: "owner pass",
    });
    expect(
      (await f.db.agentMessageDelivery.findFirstOrThrow({ where: { messageId: comment.id } }))
        .reason,
    ).toBe("subscribed");
    const repository = new PrismaDirectConversationRepository(f.db);
    expect(
      (await repository.readPendingAgentDeliveries(f.workspace.id, f.principal.agentId)).map(
        (delivery) => delivery.messageId,
      ),
    ).toEqual([comment.id]);
    await f.db.conversationMember.update({
      where: {
        conversationId_agentId: {
          conversationId: f.conversation.id,
          agentId: f.principal.agentId,
        },
      },
      data: { leftAt: new Date() },
    });
    expect(
      await repository.readPendingAgentDeliveries(f.workspace.id, f.principal.agentId),
    ).toEqual([]);
  } finally {
    await f.close();
  }
});

test("an unseated subscribed Agent drains a comment delivery exactly once and may reply to it", async () => {
  const f = await agentAttachmentMessagesFixture();
  try {
    // The file's uploader Agent, subscribed by ownership but never seated in the discussion.
    await f.db.attachment.update({
      where: { id: f.attachment.id },
      data: { uploaderId: null, uploaderAgentId: f.principal.agentId },
    });
    const comment = await f.comments.post(f.actor, {
      attachmentId: f.attachment.id,
      body: "notify the uploader",
    });
    const stored = await f.db.message.findUniqueOrThrow({ where: { id: comment.id } });
    expect(
      await f.db.conversationMember.count({
        where: { conversationId: stored.conversationId, agentId: f.principal.agentId },
      }),
    ).toBe(0);
    const repository = new PrismaDirectConversationRepository(f.db);
    const first = await repository.drainAgentEvents(f.workspace.id, f.principal.agentId);
    expect(first.messages).toMatchObject([
      { id: comment.id, target: `attachment:${f.attachment.id}` },
    ]);
    // It may reply on the attachment: never a non-member mention.
    expect(first.messages[0]!.nonMemberMention).toBeUndefined();
    // The drain took a read seat and advanced the cursor, so the next check is empty.
    expect(
      await f.db.conversationMember.count({
        where: { conversationId: stored.conversationId, agentId: f.principal.agentId },
      }),
    ).toBe(1);
    const second = await repository.drainAgentEvents(f.workspace.id, f.principal.agentId);
    expect(second.messages).toEqual([]);
  } finally {
    await f.close();
  }
});
