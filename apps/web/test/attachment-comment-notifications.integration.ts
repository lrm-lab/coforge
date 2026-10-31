import { expect, test } from "bun:test";
import { ActivityInbox } from "#src/server/inbox/activity-inbox.server";
import { activityOpenTarget } from "#src/features/inbox/activity-open-target";
import { peopleDirectKey } from "#src/features/conversations/direct-key";
import { AttachmentComments } from "#src/server/attachments/attachment-comments.server";
import { attachmentCommentNotices } from "#src/server/attachments/attachment-comment-notices.server";
import { PrismaAttachmentCommentStore } from "#src/server/db/repositories/attachment-comments.repositories.server";
import { pendingMentionActionsForMessage } from "#src/server/conversations/pending-mention-views.server";
import { claimMentionActions } from "#src/server/conversations/pending-mention-actions.server";
import { recordingDeliveries } from "./helpers/fake-centrifugo";
import { attachmentCommentsFixture } from "./helpers/attachment-comments-fixture";
import { agentAttachmentMessagesFixture } from "./helpers/agent-attachment-messages-fixture";

/**
 * Attachment comment notifications: the uploader, prior commenters and @-mentioned members are
 * notified in the comment's own transaction — people through a `pending_mention_actions` row
 * (reason `subscribed`/`mentioned`, never sender-actionable), Agents through a delivery pushed
 * `attachment:<id>` — each re-checked for read access on the source conversation, with a mute
 * that subscribed notifications respect and mentions pierce.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */

const noticesFor = (f: Awaited<ReturnType<typeof attachmentCommentsFixture>>) => {
  const { publisher, delivered } = recordingDeliveries();
  const activityChanged: { workspaceId: string; userId: string }[] = [];
  const notices = attachmentCommentNotices(f.db, publisher, {
    activityChanged: async (event) => {
      activityChanged.push(event);
    },
  });
  const comments = new AttachmentComments(new PrismaAttachmentCommentStore(f.db));
  return { comments, notices, delivered, activityChanged };
};

const pmaOf = (f: Awaited<ReturnType<typeof attachmentCommentsFixture>>, messageId: string) =>
  f.db.pendingMentionAction.findMany({ where: { messageId } });

test("the uploader and prior commenters are notified as subscribed; the author never is", async () => {
  const f = await attachmentCommentsFixture();
  try {
    const { comments, notices, activityChanged } = noticesFor(f);
    // member comments: owner is the uploader and had not commented before.
    const first = await comments.post(
      { workspaceId: f.workspace.id, userId: f.member.id },
      { attachmentId: f.attachment.id, body: "Looks good" },
      notices,
    );
    expect(await pmaOf(f, first.id)).toMatchObject([
      { targetUserId: f.owner.id, reason: "subscribed", targetHandle: f.owner.username },
    ]);
    expect(activityChanged).toEqual([{ workspaceId: f.workspace.id, userId: f.owner.id }]);
    // owner replies: member is a prior commenter, owner is the author.
    const reply = await comments.post(
      f.actor,
      { attachmentId: f.attachment.id, body: "Thanks", rootId: first.id },
      notices,
    );
    expect(await pmaOf(f, reply.id)).toMatchObject([
      { targetUserId: f.member.id, reason: "subscribed" },
    ]);
    // Nobody outside the source conversation ever lands in the sender's actionable lists.
    expect(
      await pendingMentionActionsForMessage(
        f.db,
        {
          id: reply.id,
          workspaceId: f.workspace.id,
          conversationId: (await pmaOf(f, reply.id))[0]!.conversationId,
          senderMemberId: reply.senderMemberId!,
          body: reply.body,
        },
        { archivedAt: null, channelName: null, visibility: "public" },
      ),
    ).toEqual([]);
    const rows = await pmaOf(f, reply.id);
    const { claimed } = await claimMentionActions(
      f.db,
      f.workspace.id,
      f.actor,
      rows.map((row) => row.id),
    );
    expect(claimed).toEqual([]);
  } finally {
    await f.close();
  }
});

test("an @-mentioned member is notified as mentioned, seated, and bypasses mute", async () => {
  const f = await attachmentCommentsFixture();
  try {
    const { comments, notices } = noticesFor(f);
    // viewer is a workspace member but NOT a #files member: a mention can't reach them (they
    // resolve among source members only), and a member who muted the channel is still told.
    await f.db.conversationMember.update({
      where: {
        conversationId_userId: { conversationId: f.conversation.id, userId: f.member.id },
      },
      data: { channelMuted: true },
    });
    const comment = await comments.post(
      f.actor,
      {
        attachmentId: f.attachment.id,
        body: `@${f.member.username} @${f.viewer.username} take a look`,
      },
      notices,
    );
    const rows = await pmaOf(f, comment.id);
    expect(rows).toMatchObject([{ targetUserId: f.member.id, reason: "mentioned" }]);
    const mention = await f.db.messageMention.findFirstOrThrow({
      where: { messageId: comment.id },
    });
    expect(mention.handle).toBe(f.member.username);
    // The muted member was still seated in the discussion for the mention row's foreign key.
    expect(await f.db.conversationMember.count({ where: { id: mention.memberId } })).toBe(1);
    // But a mute quiets a subscribed notification: member comments next, owner is muted now.
    await f.db.conversationMember.update({
      where: {
        conversationId_userId: { conversationId: f.conversation.id, userId: f.owner.id },
      },
      data: { channelMuted: true },
    });
    const second = await comments.post(
      { workspaceId: f.workspace.id, userId: f.member.id },
      { attachmentId: f.attachment.id, body: "bumping this" },
      notices,
    );
    expect(await pmaOf(f, second.id)).toEqual([]);
  } finally {
    await f.close();
  }
});

test("an Agent recipient gets a delivery and an attachment-target push", async () => {
  const f = await attachmentCommentsFixture();
  try {
    const { comments, notices, delivered } = noticesFor(f);
    const agent = await f.db.agent.create({
      data: {
        workspaceId: f.workspace.id,
        ownerId: f.owner.id,
        name: `watcher-${crypto.randomUUID().slice(0, 8)}`,
        displayName: "Watcher",
        runtimeConfig: {},
      },
    });
    await f.db.conversationMember.create({
      data: {
        workspaceId: f.workspace.id,
        conversationId: f.conversation.id,
        agentId: agent.id,
      },
    });
    // A delivery only pushes to a daemon, so the Agent needs a Computer.
    const computer = await f.db.computer.create({
      data: {
        ownerId: f.owner.id,
        machineId: crypto.randomUUID(),
        name: `box-${crypto.randomUUID().slice(0, 8)}`,
        displayName: "Box",
      },
    });
    await f.db.workspaceComputer.create({
      data: { workspaceId: f.workspace.id, computerId: computer.id },
    });
    await f.db.agent.update({
      where: { id: agent.id },
      data: { computerId: computer.id },
    });
    const comment = await comments.post(
      f.actor,
      { attachmentId: f.attachment.id, body: `FYI @${agent.name}` },
      notices,
    );
    const delivery = await f.db.agentMessageDelivery.findFirstOrThrow({
      where: { messageId: comment.id, agentId: agent.id },
    });
    expect(delivery.reason).toBe("mentioned");
    expect(delivered).toMatchObject([
      {
        target: `attachment:${f.attachment.id}`,
        agentId: agent.id,
        mentionsAgent: true,
        reason: "mentioned",
      },
    ]);
    // The fixture's teardown removes users directly, which a Computer's RESTRICT owner key
    // would refuse; remove the box it needed first.
    await f.db.agent.update({ where: { id: agent.id }, data: { computerId: null } });
    await f.db.workspaceComputer.deleteMany({ where: { computerId: computer.id } });
    await f.db.computer.delete({ where: { id: computer.id } });
  } finally {
    await f.close();
  }
});

test("a recipient who lost source access is skipped, and the inbox stops listing their item", async () => {
  const f = await attachmentCommentsFixture();
  try {
    const { comments, notices } = noticesFor(f);
    // member's comment notifies the uploader (owner); owner's reply notifies the prior commenter
    // (member) — a notification item each already has.
    const first = await comments.post(
      { workspaceId: f.workspace.id, userId: f.member.id },
      { attachmentId: f.attachment.id, body: "first pass" },
      notices,
    );
    const reply = await comments.post(
      f.actor,
      { attachmentId: f.attachment.id, body: "second pass", rootId: first.id },
      notices,
    );
    expect(await pmaOf(f, reply.id)).toMatchObject([
      { targetUserId: f.member.id, reason: "subscribed" },
    ]);
    // member loses access to the source: the channel goes private and they leave.
    await f.db.conversation.update({
      where: { id: f.conversation.id },
      data: { visibility: "private" },
    });
    await f.db.conversationMember.update({
      where: {
        conversationId_userId: { conversationId: f.conversation.id, userId: f.member.id },
      },
      data: { leftAt: new Date() },
    });
    // No new notification reaches them, and the one they already had leaves the inbox — the
    // reader rechecks the same rule.
    const third = await comments.post(
      f.actor,
      { attachmentId: f.attachment.id, body: "third pass" },
      notices,
    );
    expect(await pmaOf(f, third.id)).toEqual([]);
    const inbox = new ActivityInbox(f.db, {});
    const memberItems = await inbox.list(f.workspace.id, f.member.id, { filter: "all" });
    expect(memberItems.items.every((candidate) => !candidate.attachmentComment)).toBe(true);

    // The inbox surfaces the first comment's notification to its recipient while they can
    // still read the source.
    const items = await inbox.list(f.workspace.id, f.owner.id, { filter: "all" });
    const item = items.items.find((candidate) => candidate.attachmentComment);
    expect(item).toMatchObject({
      key: `mention:${item!.mentionAction!.resolutionId}`,
      attachmentComment: {
        attachmentId: f.attachment.id,
        fileName: "review.txt",
        threadRootId: null,
      },
      unreadCount: 1,
    });
    expect(item?.place).toMatchObject({ kind: "channel", channelName: "files" });
    // It opens the file's own conversation, at the message the file rides on.
    expect(activityOpenTarget(item!)).toEqual({
      kind: "channel",
      id: f.conversation.id,
      messageId: f.message.id,
      attachmentId: f.attachment.id,
      commentId: first.id,
    });
    // Done clears it through the same row the channel-mention items use.
    await inbox.markDone(f.workspace.id, f.owner.id, {
      kind: "mention_action",
      resolutionId: item!.mentionAction!.resolutionId,
    });
    const after = await inbox.list(f.workspace.id, f.owner.id, { filter: "all" });
    expect(after.items.every((candidate) => !candidate.attachmentComment)).toBe(true);
  } finally {
    await f.close();
  }
});

test("a comment on a DM attachment notifies the peer's inbox and the item opens the DM", async () => {
  const f = await attachmentCommentsFixture();
  try {
    const { comments, notices } = noticesFor(f);
    const dm = await f.db.conversation.create({
      data: {
        workspaceId: f.workspace.id,
        directKey: peopleDirectKey(f.owner.id, f.member.id),
        members: {
          create: [{ userId: f.owner.id }, { userId: f.member.id }],
        },
      },
    });
    const ownerSeat = await f.db.conversationMember.findFirstOrThrow({
      where: { conversationId: dm.id, userId: f.owner.id },
    });
    const sourceMessage = await f.db.message.create({
      data: {
        workspaceId: f.workspace.id,
        conversationId: dm.id,
        senderMemberId: ownerSeat.id,
        body: "see this",
        sequence: 1,
      },
    });
    const dmAttachment = await f.db.attachment.create({
      data: {
        workspaceId: f.workspace.id,
        conversationId: dm.id,
        messageId: sourceMessage.id,
        uploaderId: f.owner.id,
        fileName: "dm-file.txt",
        contentType: "text/plain",
        sizeBytes: 3,
        objectKey: crypto.randomUUID(),
      },
    });
    const comment = await comments.post(
      { workspaceId: f.workspace.id, userId: f.member.id },
      { attachmentId: dmAttachment.id, body: "noted" },
      notices,
    );
    // The other side of the DM is notified as the file's uploader.
    expect(await pmaOf(f, comment.id)).toMatchObject([
      { targetUserId: f.owner.id, reason: "subscribed" },
    ]);
    const inbox = new ActivityInbox(f.db, {});
    const items = await inbox.list(f.workspace.id, f.owner.id, { filter: "all" });
    const item = items.items.find((candidate) => candidate.attachmentComment);
    expect(item).toMatchObject({
      place: { kind: "direct", conversationId: dm.id },
      attachmentComment: {
        attachmentId: dmAttachment.id,
        fileName: "dm-file.txt",
        sourceMessageId: sourceMessage.id,
      },
    });
    // The open target is the DM itself at the file's message — never a dead channel URL.
    expect(activityOpenTarget(item!)).toEqual({
      kind: "dm",
      id: dm.id,
      messageId: sourceMessage.id,
      attachmentId: dmAttachment.id,
      commentId: comment.id,
    });
    // And it lights the nav dot for the recipient.
    await expect(inbox.navAttention(f.workspace.id, f.owner.id)).resolves.toEqual({
      hasUnread: true,
    });
  } finally {
    await f.close();
  }
});

test("a comment living in the migrated source conversation still reads as an attachment comment", async () => {
  const f = await attachmentCommentsFixture();
  try {
    // The post-migration shape: the thread, the comment's Message, its attachmentComment row
    // and its notification all carry the source channel's id.
    await f.db.attachmentCommentThread.create({
      data: {
        attachmentId: f.attachment.id,
        workspaceId: f.workspace.id,
        conversationId: f.conversation.id,
      },
    });
    const sender = await f.db.conversationMember.findFirstOrThrow({
      where: { conversationId: f.conversation.id, userId: f.member.id },
    });
    const comment = await f.db.message.create({
      data: {
        conversationId: f.conversation.id,
        workspaceId: f.workspace.id,
        senderMemberId: sender.id,
        sequence: 2,
        body: "post-migration shape",
      },
    });
    await f.db.attachmentComment.create({
      data: {
        attachmentId: f.attachment.id,
        workspaceId: f.workspace.id,
        conversationId: f.conversation.id,
        messageId: comment.id,
      },
    });
    await f.db.pendingMentionAction.create({
      data: {
        messageId: comment.id,
        conversationId: f.conversation.id,
        workspaceId: f.workspace.id,
        senderMemberId: sender.id,
        targetUserId: f.owner.id,
        targetHandle: f.owner.username,
        expiresAt: new Date(Date.now() + 86_400_000),
        notifiedAt: comment.createdAt,
        reason: "subscribed",
      },
    });
    const inbox = new ActivityInbox(f.db, {});
    const items = await inbox.list(f.workspace.id, f.owner.id, { filter: "all" });
    const item = items.items.find((candidate) => candidate.mentionAction);
    expect(item?.latest.id).toBe(comment.id);
    expect(item?.attachmentComment).toMatchObject({
      attachmentId: f.attachment.id,
      fileName: "review.txt",
      sourceMessageId: f.message.id,
    });
  } finally {
    await f.close();
  }
});

test("an Agent's comment notifies the human uploader and surfaces in their inbox", async () => {
  const f = await agentAttachmentMessagesFixture();
  try {
    const posted = await f.messages.executeFromAgent({
      ...f.principal,
      target: f.target,
      body: "agent review done",
      idempotencyKey: crypto.randomUUID(),
    });
    // The uploader is a subscribed recipient — the same row a person's comment writes.
    expect(await pmaOf(f, posted.id)).toMatchObject([
      { targetUserId: f.owner.id, reason: "subscribed" },
    ]);
    // And it surfaces in the uploader's Activity inbox.
    const inbox = new ActivityInbox(f.db, {});
    const items = await inbox.list(f.workspace.id, f.owner.id, { filter: "all" });
    const item = items.items.find((candidate) => candidate.attachmentComment);
    expect(item).toMatchObject({
      attachmentComment: { attachmentId: f.attachment.id },
    });
  } finally {
    await f.close();
  }
});
