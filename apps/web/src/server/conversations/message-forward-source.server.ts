import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import {
  ATTACHMENT_VIEW_SELECT,
  type AttachmentViewRow,
} from "#src/server/attachments/attachment-view.server";
import { PrismaAttachmentCommentStore } from "#src/server/db/repositories/attachment-comments.repositories.server";
import type { MentionRef } from "#src/features/conversations/mention-text";
import { ConversationHistory } from "./conversation-history.server";
import { BROWSER_MESSAGE_MENTIONS_SELECT, browserMessageMention } from "./mentions.server";
import { peopleReadableBody } from "./message-preview-line.server";
import { browserSenderHandle, browserSenderName } from "./sender-display.server";

/** `errorId` of the `INVALID_INPUT` a source that cannot be forwarded is refused with. */
export const FORWARD_NOT_FORWARDABLE = "forward-not-forwardable";

/** One message to forward, frozen: what the new message's `MessageForward` row stores, and the
 * original's uploads, which the destination gets copies of. */
export type ForwardSource = {
  /** Null for a comment on an attachment, which has no place in a conversation to open. */
  sourceMessageId: string | null;
  sourceConversationId: string;
  sourceThreadRootId: string | null;
  sourceConversationName: string | null;
  sourceSenderName: string;
  sourceSenderHandle: string;
  sourceCreatedAt: Date;
  /** Mentions and references already read back as plain text, so storing it notifies no one. It is
   * computed from `sourceRawBody` and `sourceMentions`, the one read of the original. */
  sourceBody: string;
  /** The original's stored body, tokens included, and its mentions, for the card's chips. */
  sourceRawBody: string;
  sourceMentions: MentionRef[];
  attachments: AttachmentViewRow[];
};

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

/**
 * The body as the card needs it: a channel or thread token keeps its name and loses its ids. The
 * card never links a token (a forward's reader may not see that channel), and a snapshot has no
 * business carrying the ids of channels the reader cannot see.
 */
export function withoutChannelIds(body: string): string {
  return body
    .replace(new RegExp(`<@channel:${UUID}:`, "g"), `<@channel:${NIL_UUID}:`)
    .replace(new RegExp(`<@thread:${UUID}:${UUID}:`, "g"), `<@thread:${NIL_UUID}:${NIL_UUID}:`);
}

const SOURCE_SELECT = {
  id: true,
  conversationId: true,
  threadRootId: true,
  body: true,
  createdAt: true,
  sender: {
    select: {
      user: { select: { username: true, displayName: true } },
      agent: { select: { name: true, displayName: true } },
    },
  },
  mentions: BROWSER_MESSAGE_MENTIONS_SELECT,
  forward: { select: { messageId: true } },
  actionCard: { select: { messageId: true } },
  conversation: { select: { kind: true, channelName: true } },
  attachments: { select: ATTACHMENT_VIEW_SELECT, orderBy: { position: "asc" as const } },
} as const;

/**
 * The message a person forwards, if they may: one they can see in a channel or direct conversation
 * of theirs, or a comment on an attachment they can read. A message that is itself a forward, an
 * action card or a server notice cannot be forwarded (`INVALID_INPUT`), and one they cannot see
 * is `NOT_FOUND`, so a refusal never tells whether it exists. A Task's message and a comment are
 * forwardable as the snapshot they are: no Task state, no comment anchor.
 */
export async function loadForwardSource(
  db: PrismaClient,
  input: { workspaceId: string; userId: string; messageId: string },
): Promise<ForwardSource> {
  const { workspaceId, userId, messageId } = input;
  const message = await db.message.findFirst({
    where: { id: messageId, workspaceId },
    select: SOURCE_SELECT,
  });
  if (!message) throw new AppError("NOT_FOUND");
  let sourceConversationId = message.conversationId;
  let sourceConversationName = message.conversation.channelName;
  let sourceMessageId: string | null = message.id;
  let sourceThreadRootId = message.threadRootId;
  if (message.conversation.kind === "attachment_comments") {
    const thread = await db.attachmentCommentThread.findUnique({
      where: { conversationId: message.conversationId },
      select: { attachmentId: true },
    });
    const access = thread
      ? await new PrismaAttachmentCommentStore(db).access(
          { workspaceId, userId },
          thread.attachmentId,
        )
      : null;
    if (!access?.canRead) throw new AppError("NOT_FOUND");
    sourceConversationId = access.sourceConversationId;
    sourceConversationName = (
      await db.conversation.findUniqueOrThrow({
        where: { id: sourceConversationId },
        select: { channelName: true },
      })
    ).channelName;
    sourceMessageId = null;
    sourceThreadRootId = null;
  } else {
    // The conversation's own read rule: a channel `canReadChannel` lets them read (a private one
    // only from inside it), a direct conversation only its members'. Neither refusal says which.
    await new ConversationHistory(db)
      .authorize(workspaceId, userId, message.conversationId)
      .catch((error: unknown) => {
        throw error instanceof AppError && error.code === "ACCESS_DENIED"
          ? new AppError("NOT_FOUND")
          : error;
      });
  }
  // A server notice has no sender, and a sender with neither a user nor an Agent has no handle.
  const sourceSenderHandle = browserSenderHandle(message.sender);
  if (message.forward || message.actionCard || sourceSenderHandle === undefined)
    throw new AppError("INVALID_INPUT", { errorId: FORWARD_NOT_FORWARDABLE });
  const sourceMentions = message.mentions.map(browserMessageMention);
  const sourceRawBody = withoutChannelIds(message.body);
  return {
    sourceMessageId,
    sourceConversationId,
    sourceThreadRootId,
    sourceConversationName,
    sourceSenderName: browserSenderName(message.sender),
    sourceSenderHandle,
    sourceCreatedAt: message.createdAt,
    sourceBody: peopleReadableBody(sourceRawBody, sourceMentions),
    sourceRawBody,
    sourceMentions,
    attachments: message.attachments,
  };
}
