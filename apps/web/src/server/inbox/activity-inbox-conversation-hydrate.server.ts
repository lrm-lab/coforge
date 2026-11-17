import { APP_BOT_LOGO_SELECT, agentFaceUrl } from "#src/server/apps/app-logo.server";
import {
  ACTION_CARD_PREVIEW_SELECT,
  previewCardFieldOf,
} from "#src/server/conversations/action-card-preview.server";
import { channelVisibilityOf } from "#src/features/conversations/channel-visibility";
import type { PrismaClient } from "#src/generated/prisma/client";
import { channelListMembers } from "#src/server/conversations/channel-list-preview.server";
import {
  browserMessageFields,
  mapBrowserMessage,
} from "#src/server/conversations/browser-message-projection.server";
import { attachForwardedAccess } from "#src/server/conversations/message-forward-view.server";
import {
  browserSenderAvatarUrl,
  browserSenderName,
} from "#src/server/conversations/sender-display.server";
import {
  peoplePeer,
  peoplePeerUserFields,
} from "#src/server/conversations/direct-conversation-peer.server";
import { peopleDirectPeerId } from "#src/features/conversations/direct-key";
import { storedTaskStatus } from "#src/server/tasks/task-view.server";
import { type ActivityPageRow } from "./activity-inbox-page-sql.server";

/** One listed item, from its page row (`activity-inbox-page-sql.server.ts`). */
export type ActivityCandidate = {
  /** The item's key on the page, the list order's last tiebreaker: its mention notification, its
   * thread, its task conversation or its conversation. */
  key: string;
  kind: "channel" | "direct";
  /** The viewer's member row the item is read through; none for a notification. */
  memberId: string | null;
  conversationId: string;
  rootMessageId: string | null;
  channelName: string | null;
  /** A channel's `Conversation.visibility`; a direct conversation's is never read. */
  visibility: string;
  /** A direct message's key, which names the member on the other side of a DM between people. */
  directKey: string | null;
  agentId: string | null;
  latestMessageId: string;
  latestSequence: number;
  latestAt: Date;
  unreadCount: number;
  firstUnreadMessageId: string | null;
  unreadMention: boolean;
  /**
   * The first message past Done that mentions the viewer, read or not: the item is listed under
   * Mentions, and opens there when it has nothing unread. Null when nothing past Done mentions them.
   */
  firstMentionMessageId: string | null;
  /** A mention the viewer was notified of from outside the channel, until they mark it Done. */
  mentionAction?: { resolutionId: string; threadRootId: string | null };
  /** An attachment-comment notification: the file the comment is on, the message the file rides
   * on (`sourceMessageId`, the message the item opens at — null while the file has none), and
   * the comment's own thread. */
  attachmentComment?: {
    attachmentId: string;
    fileName: string;
    threadRootId: string | null;
    sourceMessageId: string | null;
  };
  /** A conversation's own item the viewer pinned: its place among their pins. Null otherwise. */
  pin: { order: number; at: Date } | null;
  /** A task conversation's item: its channel board, which is where the item lives, and the task. */
  task?: { boardId: string; number: number; title: string };
};

/** Loads the messages, DM peers (Agents and members), channel avatar members and tasks one page
 * of items renders, in a fixed number of queries. */
export async function hydrateConversationItems(
  db: PrismaClient,
  workspaceId: string,
  userId: string,
  page: readonly ActivityCandidate[],
) {
  const messageIds = new Set<string>();
  const agentIds = new Set<string>();
  // The member on the other side of each DM between people (the viewer, in their own), by key.
  const peerUserIds = new Map<string, string>();
  const rootIds: string[] = [];
  const channelIds = new Set<string>();
  for (const candidate of page) {
    messageIds.add(candidate.latestMessageId);
    if (candidate.kind === "channel")
      channelIds.add(candidate.task?.boardId ?? candidate.conversationId);
    if (candidate.rootMessageId) {
      messageIds.add(candidate.rootMessageId);
      rootIds.push(candidate.rootMessageId);
    }
    if (candidate.agentId) agentIds.add(candidate.agentId);
    const peerUserId = peopleDirectPeerId(candidate.directKey, userId);
    if (peerUserId) peerUserIds.set(candidate.conversationId, peerUserId);
  }
  const [messages, agents, people, channelMembers, tasks] = await Promise.all([
    db.message.findMany({
      where: { id: { in: [...messageIds] }, workspaceId },
      // A card's row reads in the viewer's language, not as its stored English body.
      select: { ...browserMessageFields, actionCard: ACTION_CARD_PREVIEW_SELECT },
    }),
    db.agent.findMany({
      where: { id: { in: [...agentIds] }, workspaceId },
      select: {
        id: true,
        name: true,
        displayName: true,
        avatarMascot: true,
        appBot: APP_BOT_LOGO_SELECT,
      },
    }),
    // By the key, not a membership: the member stays named after leaving the Workspace.
    db.user.findMany({
      where: { id: { in: [...new Set(peerUserIds.values())] } },
      select: peoplePeerUserFields,
    }),
    // The members a channel's group avatar shows, as on the Chat sidebar's row.
    channelListMembers(db, workspaceId, [...channelIds]),
    db.task.findMany({
      where: { messageId: { in: rootIds }, workspaceId, deletedAt: null },
      select: {
        messageId: true,
        number: true,
        status: true,
        owner: {
          select: {
            userId: true,
            agentId: true,
            user: { select: { username: true, displayName: true, avatarObjectKey: true } },
            agent: {
              select: {
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
    }),
  ]);
  const settledMessages = await attachForwardedAccess(
    db,
    workspaceId,
    userId,
    messages.map((message) => ({
      ...mapBrowserMessage(message, workspaceId),
      ...previewCardFieldOf(message.actionCard),
    })),
  );
  const messageById = new Map(settledMessages.map((message) => [message.id, message]));
  const agentById = new Map(
    agents.map((agent) => [
      agent.id,
      {
        kind: "agent" as const,
        agentId: agent.id,
        displayName: agent.displayName.trim() || agent.name,
        avatarUrl: agentFaceUrl(agent),
      },
    ]),
  );
  const personById = new Map(people.map((person) => [person.id, peoplePeer(workspaceId, person)]));
  const taskByRoot = new Map(
    tasks.map((task) => [
      task.messageId,
      {
        number: task.number,
        status: storedTaskStatus(task.status),
        ownerName: task.owner ? browserSenderName(task.owner) : null,
        // The owner's face, drawn beside the name (task #521).
        ownerFace: task.owner
          ? {
              kind: task.owner.userId ? ("user" as const) : ("agent" as const),
              id: task.owner.userId ?? task.owner.agentId ?? undefined,
              avatarUrl: browserSenderAvatarUrl(task.owner, workspaceId),
            }
          : null,
        // A deleted Agent keeps its Tasks; the card says so instead of reading as a live owner.
        ownerDeleted: Boolean(task.owner?.agent?.deletedAt),
      },
    ]),
  );
  return page.flatMap((candidate) => {
    const latest = messageById.get(candidate.latestMessageId);
    const peerUserId = peerUserIds.get(candidate.conversationId);
    const peer = peerUserId
      ? personById.get(peerUserId)
      : candidate.agentId
        ? agentById.get(candidate.agentId)
        : undefined;
    const place =
      candidate.kind === "channel"
        ? {
            kind: "channel" as const,
            // A task conversation's place is its board; the item's own conversation is the task's.
            conversationId: candidate.task?.boardId ?? candidate.conversationId,
            channelName: candidate.channelName ?? "",
            visibility: channelVisibilityOf(candidate),
            members: channelMembers.get(candidate.task?.boardId ?? candidate.conversationId) ?? [],
          }
        : peer
          ? { kind: "direct" as const, conversationId: candidate.conversationId, peer }
          : null;
    const root = candidate.rootMessageId ? messageById.get(candidate.rootMessageId) : null;
    // A row deleted between the two reads leaves the page rather than rendering half an item.
    if (!latest || !place || root === undefined) return [];
    return [
      {
        key: candidate.key,
        place,
        // A channel thread is listed because the viewer follows it; a direct-message thread
        // has no follow switch.
        thread: root ? { root, task: taskByRoot.get(root.id) ?? null } : null,
        // A task conversation: its number and title on the board, and the conversation Done and
        // reads name (`conversationId`, in the `conversation` kind of item).
        task: candidate.task
          ? { ...candidate.task, conversationId: candidate.conversationId }
          : null,
        latest,
        latestSequence: candidate.latestSequence,
        unreadCount: candidate.unreadCount,
        firstUnreadMessageId: candidate.firstUnreadMessageId,
        unreadMention: candidate.unreadMention,
        firstMentionMessageId: candidate.firstMentionMessageId,
        mentionAction: candidate.mentionAction ?? null,
        attachmentComment: candidate.attachmentComment ?? null,
        /** The viewer pinned this conversation, in whichever view lists it. */
        pinned: candidate.pin !== null,
      },
    ];
  });
}
/** A candidate from its page row. */
export function activityCandidate({
  key,
  unreadItemCount: _unreadItemCount,
  unreadMentionItemCount: _unreadMentionItemCount,
  activeItemCount: _activeItemCount,
  isPin: _isPin,
  pastDone: _pastDone,
  hasUnread: _hasUnread,
  pinOrder,
  pinnedAt,
  taskBoardId,
  taskNumber,
  taskTitle,
  mentionId,
  noticeThreadRootId,
  attachmentId,
  attachmentFileName,
  attachmentSourceMessageId,
  ...row
}: ActivityPageRow): ActivityCandidate {
  return {
    ...row,
    key: key!,
    ...(mentionId && {
      mentionAction: {
        resolutionId: mentionId,
        // A comment notification opens its file's comment thread, not a thread of the source.
        threadRootId: attachmentId ? null : noticeThreadRootId,
      },
    }),
    ...(attachmentId && {
      attachmentComment: {
        attachmentId,
        fileName: attachmentFileName!,
        threadRootId: noticeThreadRootId,
        sourceMessageId: attachmentSourceMessageId,
      },
    }),
    pin: pinOrder !== null && pinnedAt !== null ? { order: pinOrder, at: pinnedAt } : null,
    ...(taskBoardId && {
      task: { boardId: taskBoardId, number: taskNumber!, title: taskTitle! },
    }),
  };
}
