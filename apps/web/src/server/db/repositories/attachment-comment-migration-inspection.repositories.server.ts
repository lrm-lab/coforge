import type { Prisma } from "#src/generated/prisma/client";
import type { AttachmentCommentMigrationSnapshot } from "#src/server/attachments/attachment-comment-migration.server";
import { unsupportedCommentMigrationDependencies } from "./attachment-comment-migration-dependencies.repositories.server";

const messageIdentity = {
  id: true,
  conversationId: true,
  workspaceId: true,
  threadRootId: true,
} as const;

/** Caller chooses a read-only snapshot or a locked maintenance transaction. */
export async function inspectAttachmentCommentMigration(
  tx: Prisma.TransactionClient,
): Promise<AttachmentCommentMigrationSnapshot> {
  const discussions = await tx.attachmentCommentThread.findMany({
    orderBy: { attachmentId: "asc" },
    select: {
      attachmentId: true,
      workspaceId: true,
      conversationId: true,
      conversation: { select: { kind: true } },
      attachment: {
        select: {
          conversationId: true,
          conversation: { select: { kind: true } },
          message: {
            select: { ...messageIdentity, threadRoot: { select: messageIdentity } },
          },
        },
      },
    },
  });
  const hidden = await tx.conversation.findMany({
    where: { kind: "attachment_comments" },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  const boundIds = new Set(discussions.map((thread) => thread.conversationId));
  const unboundConversationIds = hidden.filter((row) => !boundIds.has(row.id)).map((row) => row.id);
  const conversationIds = [...new Set([...boundIds, ...hidden.map((row) => row.id)])];
  const sourceIds = [...new Set(discussions.map((thread) => thread.attachment.conversationId))];
  const messages = await tx.message.findMany({
    where: { conversationId: { in: conversationIds } },
    orderBy: [{ conversationId: "asc" }, { sequence: "asc" }],
    select: {
      ...messageIdentity,
      sequence: true,
      senderMemberId: true,
      createdAt: true,
      attachmentComment: { select: { attachmentId: true } },
      sender: { select: { userId: true, agentId: true } },
    },
  });
  const sequences = await tx.message.groupBy({
    by: ["conversationId"],
    where: { conversationId: { in: sourceIds } },
    _max: { sequence: true },
  });
  const reactionCount = await tx.messageReaction.count({
    where: { conversationId: { in: conversationIds } },
  });
  const members = await tx.conversationMember.findMany({
    where: { conversationId: { in: [...conversationIds, ...sourceIds] } },
    select: {
      id: true,
      conversationId: true,
      userId: true,
      agentId: true,
      readThroughSequence: true,
      agentReadThroughSequence: true,
      doneThroughSequence: true,
      unreadFromSequence: true,
    },
  });
  const referenceSelection = { memberId: true, conversationId: true } as const;
  const referenceScope = { conversationId: { in: conversationIds } };
  const reactions = await tx.messageReaction.findMany({
    where: referenceScope,
    select: referenceSelection,
  });
  const mentions = await tx.messageMention.findMany({
    where: referenceScope,
    select: referenceSelection,
  });
  const saved = await tx.savedMessage.findMany({
    where: referenceScope,
    select: referenceSelection,
  });
  // A comment notification's sender seat moves with its message, like a reaction's actor.
  const mentionSenders = await tx.pendingMentionAction.findMany({
    where: referenceScope,
    select: { senderMemberId: true, conversationId: true },
  });
  const references = [
    ...reactions,
    ...mentions,
    ...saved,
    ...mentionSenders.map((row) => ({
      memberId: row.senderMemberId,
      conversationId: row.conversationId,
    })),
  ];
  const roots = [
    ...new Set(
      discussions.flatMap((row) =>
        row.attachment.message
          ? [row.attachment.message.threadRootId ?? row.attachment.message.id]
          : [],
      ),
    ),
  ];
  const sourceReplies = await tx.message.findMany({
    where: { conversationId: { in: sourceIds }, threadRootId: { in: roots } },
    select: { id: true, conversationId: true, threadRootId: true, sequence: true },
    orderBy: [{ conversationId: "asc" }, { sequence: "asc" }],
  });
  const threadReads = await tx.threadRead.findMany({
    where: { conversationId: { in: [...conversationIds, ...sourceIds] } },
    select: {
      memberId: true,
      conversationId: true,
      rootMessageId: true,
      readThroughSequence: true,
      doneThroughSequence: true,
    },
  });
  const assistantSessions = await tx.workspaceAssistantSession.findMany({
    where: { workspaceId: { in: [...new Set(discussions.map((row) => row.workspaceId))] } },
    select: { id: true, agentId: true, workspaceId: true },
  });
  const assistantCursors = await tx.workspaceAssistantReadCursor.findMany({
    where: { conversationId: { in: [...conversationIds, ...sourceIds] } },
    select: { sessionId: true, conversationId: true, scope: true, readThroughSequence: true },
  });
  const referencedMembers = [
    ...messages
      .filter((row) => row.senderMemberId !== null)
      .map((row) => ({
        memberId: row.senderMemberId!,
        conversationId: row.conversationId,
      })),
    ...references,
  ];
  const unexpectedDependencies = await unsupportedCommentMigrationDependencies(tx, {
    conversations: conversationIds,
    messages: messages.map((message) => message.id),
    members: members
      .filter((member) => conversationIds.includes(member.conversationId))
      .map((member) => member.id),
    sourceConversations: sourceIds,
    attachments: discussions.map((thread) => thread.attachmentId),
  });
  return {
    threads: discussions.map((thread) => ({
      attachmentId: thread.attachmentId,
      workspaceId: thread.workspaceId,
      conversationId: thread.conversationId,
      sourceConversationId: thread.attachment.conversationId,
      sourceKind: thread.attachment.conversation.kind,
      legacyKind: thread.conversation.kind,
      source: thread.attachment.message,
    })),
    messages: messages.map((message) => ({
      id: message.id,
      conversationId: message.conversationId,
      workspaceId: message.workspaceId,
      threadRootId: message.threadRootId,
      sequence: message.sequence,
      createdAt: message.createdAt.toISOString(),
      attachmentId: message.attachmentComment?.attachmentId ?? null,
      sender: message.sender,
    })),
    lastSequences: sequences.map((row) => ({
      conversationId: row.conversationId,
      sequence: row._max.sequence ?? 0,
    })),
    members,
    sourceReplies: sourceReplies.map((row) => ({ ...row, threadRootId: row.threadRootId! })),
    threadReads,
    assistantSessions,
    assistantCursors,
    referencedMembers,
    reactionCount,
    unboundConversationIds,
    unexpectedDependencies,
  };
}
