import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import type { ForwardedMessageView } from "#src/features/conversations/message-forward";
import type { MentionRef } from "#src/features/conversations/mention-text";
import { VISIBLE_CONVERSATION_WHERE } from "./active-member.server";
import type { ForwardSource } from "./message-forward-source.server";
import type { SentMessageHook } from "./sent-message-hook.server";

/** The snapshot columns a browser message of a forward is built from. */
export const BROWSER_FORWARD_SELECT = {
  select: {
    sourceMessageId: true,
    sourceConversationId: true,
    sourceThreadRootId: true,
    sourceConversationName: true,
    sourceSenderHandle: true,
    sourceCreatedAt: true,
    sourceBody: true,
    sourceRawBody: true,
    sourceMentions: true,
  },
} satisfies NonNullable<Prisma.MessageSelect["forward"]>;

type BrowserForwardRow = Prisma.MessageForwardGetPayload<typeof BROWSER_FORWARD_SELECT>;

/**
 * A forward as the browser reads it. `sourceAccessible` starts false: whether this viewer may
 * open the original is decided per viewer, in one batched lookup per page
 * (`attachForwardedAccess`), so a surface that never runs it shows a card with no "open original".
 */
export function browserForwarded(row: BrowserForwardRow): ForwardedMessageView {
  return {
    sourceSenderHandle: row.sourceSenderHandle,
    sourceCreatedAt: row.sourceCreatedAt.toISOString(),
    sourceBody: row.sourceBody,
    // Both or neither: the card draws chips only from a body and the mentions it was read with.
    ...(row.sourceRawBody !== null && Array.isArray(row.sourceMentions)
      ? { sourceRawBody: row.sourceRawBody, sourceMentions: row.sourceMentions as MentionRef[] }
      : {}),
    sourceConversation: {
      id: row.sourceConversationId,
      name: row.sourceConversationName,
    },
    ...(row.sourceThreadRootId ? { sourceThreadRootId: row.sourceThreadRootId } : {}),
    ...(row.sourceMessageId ? { sourceMessageId: row.sourceMessageId } : {}),
    sourceAccessible: false,
  };
}

/**
 * Settles `sourceAccessible` (and a channel's current name) for the forwards among `messages`, for
 * one viewer, in one lookup of the conversations they came from. The original is open to a viewer
 * who can read its conversation: any channel of the Workspace not hidden from it, a direct
 * conversation only to its members, and only while the original still exists.
 */
export async function attachForwardedAccess<T extends { forwarded?: ForwardedMessageView }>(
  db: Pick<PrismaClient, "conversation">,
  workspaceId: string,
  viewerUserId: string,
  messages: readonly T[],
): Promise<T[]> {
  const sourceIds = new Set<string>();
  for (const message of messages)
    if (message.forwarded?.sourceMessageId) sourceIds.add(message.forwarded.sourceConversation.id);
  if (!sourceIds.size) return [...messages];
  const conversations = await db.conversation.findMany({
    where: { id: { in: [...sourceIds] }, workspaceId, ...VISIBLE_CONVERSATION_WHERE },
    select: {
      id: true,
      channelName: true,
      directKey: true,
      members: { where: { userId: viewerUserId }, select: { id: true }, take: 1 },
    },
  });
  const byId = new Map(conversations.map((conversation) => [conversation.id, conversation]));
  return messages.map((message) => {
    const forwarded = message.forwarded;
    if (!forwarded?.sourceMessageId) return message;
    const conversation = byId.get(forwarded.sourceConversation.id);
    if (!conversation) return message;
    const accessible =
      conversation.channelName !== null ||
      (conversation.directKey !== null && conversation.members.length > 0);
    return {
      ...message,
      forwarded: {
        ...forwarded,
        sourceConversation: {
          ...forwarded.sourceConversation,
          name: conversation.channelName ?? forwarded.sourceConversation.name,
        },
        sourceAccessible: accessible,
      },
    };
  });
}

/** Stores the forward's snapshot with the message that carries it, in the send's transaction. */
export function recordForward(source: ForwardSource): SentMessageHook {
  return async (tx, message) => {
    await tx.messageForward.create({
      data: {
        messageId: message.id,
        sourceMessageId: source.sourceMessageId,
        sourceConversationId: source.sourceConversationId,
        sourceThreadRootId: source.sourceThreadRootId,
        sourceConversationName: source.sourceConversationName,
        sourceSenderName: source.sourceSenderName,
        sourceSenderHandle: source.sourceSenderHandle,
        sourceCreatedAt: source.sourceCreatedAt,
        sourceBody: source.sourceBody,
        sourceRawBody: source.sourceRawBody,
        sourceMentions: source.sourceMentions,
      },
    });
  };
}
