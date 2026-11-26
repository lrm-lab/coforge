import { ACTION_CARD_PREVIEW_SELECT, previewCardFieldOf } from "./action-card-preview.server";
import type { PreviewCard } from "#src/features/conversations/action-card-preview";
import { isUserAgentDirectKey, peopleDirectPeerId } from "#src/features/conversations/direct-key";
import { REALTIME_EVENTS } from "#src/features/realtime/realtime-events";
import {
  channelVisibilityOf,
  type ChannelVisibility,
} from "#src/features/conversations/channel-visibility";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { humanLabel } from "#src/lib/human-label";
import { APP_BOT_LOGO_SELECT, agentFaceUrl } from "#src/server/apps/app-logo.server";
import { clampPageLimit } from "#src/server/db/page-limit.server";
import { workspaceUserAvatarUrl } from "#src/server/db/repositories/user-profile.repositories.server";
import { ACTIVE_MEMBER_WHERE } from "./active-member.server";
import { readableConversationWhere } from "./channel-read-access.server";
import { browserMessageFields, mapBrowserMessage } from "./browser-message-projection.server";
import { attachForwardedAccess } from "./message-forward-view.server";
import { announceViewerEvent, type ConversationRealtime } from "./conversation-realtime.server";

/**
 * A signed-in user's own Saved list (#120), one `SavedMessage` row per saved message. The row
 * hangs off the message exactly like `Task` does — compound `(messageId, conversationId)` FK to
 * the message plus the member's `(memberId, conversationId, workspaceId)` FK — so saving never
 * invents a second addressing scheme for messages.
 *
 * Conversation-scope authorization is settled by those two lookups rather than by a separate
 * access helper: the message must exist in the conversation given, and saving requires an
 * *active* membership — the same seam `toggleUserMessageReaction` applies (the compound member
 * FK makes it structural: no member row, no save). Reading is scoped through the viewer's own
 * member rows instead, and like pins it is independent of leave for a DM or public channel: a
 * soft-left member still sees (and can clear) the bookmarks made while they were active — `leftAt`
 * only blocks new saves. A private channel they left is the exception for reading: its bookmarks
 * leave the list until they can read it again (they can still clear them). A person with no member
 * row at all cannot clear anything: that is `NOT_FOUND`, like a missing message.
 *
 * Conversation-scope ownership for DMs/channels beyond membership stays with the caller, next
 * to its send paths, exactly as the reaction repository documents.
 *
 * A save or unsave that changed the list tells the person's other pages (`saved.added.v1` /
 * `saved.removed.v1`, Slack's `star_added` / `star_removed`) once it has committed.
 */
export async function saveUserMessage(
  db: PrismaClient,
  input: {
    workspaceId: string;
    conversationId: string;
    userId: string;
    messageId: string;
  },
  realtime?: Pick<ConversationRealtime, "viewerChanged">,
): Promise<void> {
  const { workspaceId, conversationId, userId, messageId } = input;
  const message = await db.message.findFirst({
    where: {
      id: messageId,
      conversationId,
      workspaceId,
      conversation: readableConversationWhere(workspaceId, { userId }),
    },
    select: { id: true },
  });
  if (!message) throw new AppError("NOT_FOUND");
  const member = await db.conversationMember.findFirst({
    where: { conversationId, workspaceId, userId, ...ACTIVE_MEMBER_WHERE },
    select: { id: true },
  });
  if (!member) throw new AppError("ACCESS_DENIED");
  // Saving twice is a no-op: the PK is (messageId, memberId), and a skipped duplicate keeps the
  // original savedAt instead of bumping it (and announces nothing).
  const { count } = await db.savedMessage.createMany({
    data: [{ messageId: message.id, conversationId, workspaceId, memberId: member.id }],
    skipDuplicates: true,
  });
  if (count === 0) return;
  await announceViewerEvent(realtime, {
    userIds: [userId],
    event: { type: REALTIME_EVENTS.savedAdded, workspaceId, conversationId, messageId: message.id },
  });
}

/**
 * Removes the viewer's own bookmark; idempotent like the reaction un-toggle (an absent row
 * succeeds). Deliberately *not* `ACTIVE_MEMBER_WHERE`: bookmarks outlive a soft leave (see the
 * module note), so a member who left must still be able to clear their list.
 */
export async function unsaveUserMessage(
  db: PrismaClient,
  input: {
    workspaceId: string;
    conversationId: string;
    userId: string;
    messageId: string;
  },
  realtime?: Pick<ConversationRealtime, "viewerChanged">,
): Promise<void> {
  const { workspaceId, conversationId, userId, messageId } = input;
  const message = await db.message.findFirst({
    where: { id: messageId, conversationId, workspaceId },
    select: { id: true },
  });
  if (!message) throw new AppError("NOT_FOUND");
  const member = await db.conversationMember.findFirst({
    where: { conversationId, workspaceId, userId },
    select: { id: true },
  });
  // No member row at all is a missing message, whatever conversation it is in.
  if (!member) throw new AppError("NOT_FOUND");
  const { count } = await db.savedMessage.deleteMany({
    where: { messageId: message.id, memberId: member.id },
  });
  if (count === 0) return;
  await announceViewerEvent(realtime, {
    userIds: [userId],
    event: {
      type: REALTIME_EVENTS.savedRemoved,
      workspaceId,
      conversationId,
      messageId: message.id,
    },
  });
}

const savedMessageSelect = {
  createdAt: true,
  conversation: {
    select: {
      id: true,
      channelName: true,
      visibility: true,
      directKey: true,
      members: {
        where: { conversation: { directKey: { not: null } } },
        select: {
          userId: true,
          agentId: true,
          user: { select: { id: true, username: true, displayName: true, avatarObjectKey: true } },
          agent: {
            select: {
              id: true,
              name: true,
              displayName: true,
              deletedAt: true,
              avatarMascot: true,
              appBot: APP_BOT_LOGO_SELECT,
            },
          },
        },
      },
    },
  },
  message: { select: { ...browserMessageFields, actionCard: ACTION_CARD_PREVIEW_SELECT } },
} as const;

export type SavedMessageRow = Prisma.SavedMessageGetPayload<{ select: typeof savedMessageSelect }>;

export type SavedDirectPeer = {
  kind: "user" | "agent";
  id: string;
  name: string;
  handle?: string;
  avatarUrl: string | null;
  deleted?: boolean;
};

export type SavedMessageView = {
  savedAt: Date;
  conversation: {
    id: string;
    channelName: string | null;
    visibility: ChannelVisibility;
    directKey: string | null;
    peer?: SavedDirectPeer;
  };
  message: ReturnType<typeof mapBrowserMessage> & { card?: PreviewCard };
};

function resolveSavedDirectPeer(
  conversation: Omit<SavedMessageRow["conversation"], "members"> & {
    members?: SavedMessageRow["conversation"]["members"];
  },
  workspaceId: string,
  viewerId?: string,
): SavedDirectPeer | undefined {
  if (conversation.channelName !== null || !conversation.directKey) return undefined;
  const members = conversation.members ?? [];
  if (isUserAgentDirectKey(conversation.directKey)) {
    const agent = members.find((member) => member.agent)?.agent;
    if (!agent) return undefined;
    return {
      kind: "agent",
      id: agent.id,
      name: agent.displayName.trim() || agent.name,
      handle: agent.name,
      avatarUrl: agentFaceUrl(agent),
      deleted: Boolean(agent.deletedAt),
    };
  }
  const peerUserId = viewerId ? peopleDirectPeerId(conversation.directKey, viewerId) : undefined;
  const person = peerUserId
    ? members.find((member) => member.userId === peerUserId)?.user
    : members.find((member) => member.user)?.user;
  if (!person) return undefined;
  return {
    kind: "user",
    id: person.id,
    name: humanLabel(person),
    avatarUrl: workspaceUserAvatarUrl(workspaceId, person.id, person.avatarObjectKey),
  };
}

export function savedMessageView(
  row: Omit<SavedMessageRow, "conversation"> & {
    conversation: Omit<SavedMessageRow["conversation"], "members"> & {
      members?: SavedMessageRow["conversation"]["members"];
    };
  },
  workspaceId: string,
  viewerId?: string,
): SavedMessageView {
  const peer = resolveSavedDirectPeer(row.conversation, workspaceId, viewerId);
  return {
    savedAt: row.createdAt,
    conversation: {
      id: row.conversation.id,
      channelName: row.conversation.channelName,
      visibility: channelVisibilityOf(row.conversation),
      directKey: row.conversation.directKey,
      ...(peer ? { peer } : {}),
    },
    message: {
      ...mapBrowserMessage(row.message, workspaceId),
      ...previewCardFieldOf(row.message.actionCard),
    },
  };
}

export const SAVED_MESSAGES_DEFAULT_LIMIT = 200;
export const SAVED_MESSAGES_MAX_LIMIT = 500;

export type SavedMessagesCursor = {
  savedAt: Date;
  messageId: string;
};

export async function listUserSavedMessages(
  db: PrismaClient,
  input: {
    workspaceId: string;
    userId: string;
    limit?: number;
    cursor?: SavedMessagesCursor;
  },
): Promise<SavedMessageView[]> {
  const { workspaceId, userId, cursor } = input;
  const take = clampPageLimit(
    input.limit ?? SAVED_MESSAGES_DEFAULT_LIMIT,
    SAVED_MESSAGES_MAX_LIMIT,
  );
  const keys = await db.savedMessage.findMany({
    where: {
      workspaceId,
      member: { workspaceId, userId },
      conversation: readableConversationWhere(workspaceId, { userId }),
      ...(cursor
        ? {
            OR: [
              { createdAt: { lt: cursor.savedAt } },
              { createdAt: cursor.savedAt, messageId: { lt: cursor.messageId } },
            ],
          }
        : {}),
    },
    select: { messageId: true, memberId: true },
    orderBy: [{ createdAt: "desc" }, { messageId: "desc" }],
    take,
  });
  if (keys.length === 0) return [];
  const rows = await db.savedMessage.findMany({
    where: {
      workspaceId,
      messageId: { in: [...new Set(keys.map((key) => key.messageId))] },
      memberId: { in: [...new Set(keys.map((key) => key.memberId))] },
    },
    select: { messageId: true, memberId: true, ...savedMessageSelect },
  });
  const byKey = new Map(rows.map((row) => [`${row.messageId}:${row.memberId}`, row] as const));
  const ordered = keys.flatMap((key) => {
    const matched = byKey.get(`${key.messageId}:${key.memberId}`);
    return matched ? [matched] : [];
  });
  if (ordered.length === 0) return [];
  const views = ordered.map((row) => savedMessageView(row, workspaceId, userId));
  const messages = await attachForwardedAccess(
    db,
    workspaceId,
    userId,
    views.map((view) => view.message),
  );
  return views.map((view, index) => ({ ...view, message: messages[index]! }));
}
