import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import type { ForwardedMessageView } from "#src/features/conversations/message-forward";
import type { MentionRef } from "#src/features/conversations/mention-text";
import { VISIBLE_CONVERSATION_WHERE } from "./active-member.server";
import { canReadChannel } from "./channel-read-access.server";
import type { ForwardSource } from "./message-forward-source.server";
import type { SentMessageHook } from "./sent-message-hook.server";

/** The snapshot columns a browser message of a forward is built from, its originals in order. */
export const BROWSER_FORWARD_SELECT = {
  orderBy: { position: "asc" },
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
} satisfies Prisma.Message$forwardsArgs;

type BrowserForwardRow = Prisma.MessageForwardGetPayload<typeof BROWSER_FORWARD_SELECT>;

/**
 * A forward's originals as the browser reads them, oldest first; undefined for a message that is
 * not a forward. `sourceAccessible` starts false: whether this viewer may open an original is
 * decided per viewer, in one batched lookup per page (`attachForwardedAccess`), so a surface that
 * never runs it shows a card with no "open original".
 */
export function browserForwarded(
  rows: readonly BrowserForwardRow[],
  attachments: readonly ForwardCopy[],
): ForwardedMessageView[] | undefined {
  if (!rows.length) return undefined;
  // One original owns every attachment of its message; with several, each copy names its own.
  if (rows.length === 1) return [browserForwardedOne(rows[0]!)];
  return rows.map((row, position) => ({
    ...browserForwardedOne(row),
    attachmentIds: copiesOf(attachments, position),
  }));
}

/** An attachment of a forward's message, as far as telling whose copy it is goes. */
export type ForwardCopy = { id: string; forwardPosition: number | null };

/** The ids of the copies of the original at `position` in a forward of several. */
export function copiesOf(attachments: readonly ForwardCopy[], position: number): string[] {
  return attachments
    .filter((attachment) => attachment.forwardPosition === position)
    .map((attachment) => attachment.id);
}

function browserForwardedOne(row: BrowserForwardRow): ForwardedMessageView {
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
 * who can read its conversation: a channel of the Workspace not hidden from it that
 * `canReadChannel` lets them read (a private one only from inside it), a direct conversation only
 * to its members, and only while the original still exists. A channel they cannot read keeps the
 * name the forward stored, never its current one.
 */
export async function attachForwardedAccess<T extends { forwarded?: ForwardedMessageView[] }>(
  db: Pick<PrismaClient, "conversation">,
  workspaceId: string,
  viewerUserId: string,
  messages: readonly T[],
): Promise<T[]> {
  const sourceIds = new Set<string>();
  for (const message of messages)
    for (const original of message.forwarded ?? [])
      if (original.sourceMessageId) sourceIds.add(original.sourceConversation.id);
  if (!sourceIds.size) return [...messages];
  const conversations = await db.conversation.findMany({
    where: { id: { in: [...sourceIds] }, workspaceId, ...VISIBLE_CONVERSATION_WHERE },
    select: {
      id: true,
      channelName: true,
      directKey: true,
      visibility: true,
      members: { where: { userId: viewerUserId }, select: { leftAt: true }, take: 1 },
    },
  });
  const byId = new Map(conversations.map((conversation) => [conversation.id, conversation]));
  const settle = (forwarded: ForwardedMessageView): ForwardedMessageView => {
    if (!forwarded.sourceMessageId) return forwarded;
    const conversation = byId.get(forwarded.sourceConversation.id);
    if (!conversation) return forwarded;
    // A channel by its active members (`canReadChannel`); a DM by any member row, as
    // `ConversationHistory.authorize` opens it.
    const [member] = conversation.members;
    const accessible =
      conversation.channelName !== null
        ? canReadChannel(conversation, member?.leftAt === null)
        : conversation.directKey !== null && member !== undefined;
    if (!accessible) return forwarded;
    return {
      ...forwarded,
      sourceConversation: {
        ...forwarded.sourceConversation,
        name: conversation.channelName ?? forwarded.sourceConversation.name,
      },
      sourceAccessible: true,
    };
  };
  return messages.map((message) =>
    message.forwarded ? { ...message, forwarded: message.forwarded.map(settle) } : message,
  );
}

/**
 * Stores the forward's snapshots with the message that carries them, in the send's transaction:
 * each original at its place. Its attachment copies name their original themselves
 * (`Attachment.forwardPosition`, set as they are copied). Each row also carries the Workspace
 * and the sender's User id (resolved from their member row once, here): the forward picker's
 * "most forwarded" read counts a person's forwards from one index instead of joining every
 * message (task #78).
 */
export function recordForward(sources: readonly ForwardSource[]): SentMessageHook {
  return async (tx, message) => {
    const sender = await tx.conversationMember.findUnique({
      where: {
        id_conversationId_workspaceId: {
          id: message.senderMemberId,
          conversationId: message.conversationId,
          workspaceId: message.workspaceId,
        },
      },
      select: { userId: true },
    });
    await tx.messageForward.createMany({
      data: sources.map((source, position) => ({
        messageId: message.id,
        position,
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
        workspaceId: message.workspaceId,
        senderUserId: sender?.userId ?? null,
      })),
    });
  };
}
