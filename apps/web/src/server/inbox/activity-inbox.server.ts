import {
  ACTION_CARD_PREVIEW_SELECT,
  previewCardFieldOf,
} from "#src/server/conversations/action-card-preview.server";
import { channelVisibilityOf } from "#src/features/conversations/channel-visibility";
import type { PrismaClient } from "#src/generated/prisma/client";
import type {
  ActivityInboxCursor,
  ActivityInboxFilter,
  ActivityItemDone,
} from "#src/features/inbox/activity-inbox.schemas";
import { agentAvatarUrl } from "#src/features/agents/agent-mascot";
import { channelListMembers } from "#src/server/conversations/channel-list-preview.server";
import {
  browserMessageFields,
  mapBrowserMessage,
} from "#src/server/conversations/conversation-history.server";
import { attachForwardedAccess } from "#src/server/conversations/message-forward-view.server";
import { browserSenderName } from "#src/server/conversations/sender-display.server";
import {
  markActivityAllRead,
  markActivityDone,
  type ActivityInboxRealtime,
} from "./activity-inbox-writes.server";
import {
  peoplePeer,
  peoplePeerUserFields,
} from "#src/server/conversations/direct-conversation-peer.server";
import { peopleDirectPeerId } from "#src/features/conversations/direct-key";
import { storedTaskStatus } from "#src/server/tasks/task-view.server";
import { clampPageLimit } from "#src/server/db/page-limit.server";
import { requireWorkspaceMember } from "#src/server/workspaces/workspace-membership.server";
import { activityPageSql, type ActivityPageRow } from "./activity-inbox-page-sql.server";
import { announceActivityAttention, navHasUnread } from "./activity-attention.server";

/**
 * A person's Activity inbox: every joined channel, every direct message of theirs (with their own
 * Agent, another member, or themself: the DMs their Direct messages list holds), every channel
 * thread they follow, and every thread in those direct messages, as long as it has activity past
 * the point where they marked it Done. Reading an item never removes it; Done does, until a newer
 * message arrives. It also lists each message whose sender had them notified of a mention from
 * outside that channel, until they mark it Done. A message between members stores no mentions and
 * notifies nobody outside the DM, so a DM between members only ever lists as itself or a thread.
 * The All view lists the viewer's pinned conversations (the Chat sidebar's Pinned) apart, in pin
 * order and whatever their Done, and leaves their conversation items out of its list.
 *
 * Unread is the Chat sidebar's rule (`HUMAN_UNREAD_BASE_SQL`), so the two surfaces agree. A
 * conversation item covers top-level messages only; a thread item covers its replies and keeps its
 * read and Done boundaries in `thread_reads`. Every cursor write is the conversation module's
 * shared SQL (`human-unread.server.ts`).
 */

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

const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;

export type ActivityInboxItem = Awaited<ReturnType<ActivityInbox["list"]>>["items"][number];

export class ActivityInbox {
  constructor(
    private readonly db: PrismaClient,
    /** Required: a write that cannot announce leaves the person's other tabs showing what it
     * cleared. A caller with nothing to tell passes `{}`. */
    private readonly realtime: ActivityInboxRealtime,
  ) {}

  /** One page of a view, newest activity first, with the Unread and Mentions counts. */
  async list(
    workspaceId: string,
    userId: string,
    options: { filter: ActivityInboxFilter; cursor?: ActivityInboxCursor; limit?: number },
  ) {
    await this.authorize(workspaceId, userId);
    // Read before the list, on the clock message `createdAt` values come from: Prisma fills them in
    // this process (`@default(now())` is generated client-side).
    const loadedAt = new Date();
    const limit = clampPageLimit(options.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const rows = await this.db.$queryRaw<ActivityPageRow[]>(
      activityPageSql(workspaceId, userId, {
        filter: options.filter,
        cursor: options.cursor,
        limit,
      }),
    );
    const counts = rows[0]!;
    const listed = rows.filter((row) => row.key !== null);
    const pins = listed.filter((row) => row.isPin);
    const page = listed.filter((row) => !row.isPin);
    const shown = page.slice(0, limit);
    // The cursor is the last item the page shows, read from the candidates rather than the
    // hydrated items: one deleted between the two reads must not move where the next page starts.
    const last = page.length > limit ? shown.at(-1)! : null;
    const [items, pinned] = await Promise.all([
      this.hydrate(workspaceId, userId, shown.map(activityCandidate)),
      pins.length > 0 ? this.hydrate(workspaceId, userId, pins.map(activityCandidate)) : [],
    ]);
    return {
      items,
      /**
       * The viewer's pinned conversations in their pin order, on the All view's first page only
       * (empty otherwise): listed whatever their Done boundary, with the item's usual fields.
       */
      pinned,
      /** How many items have something unread, whatever the filter: the Unread tab's count. */
      unreadItemCount: counts.unreadItemCount,
      /** How many items have an unread mention, whatever the filter: the Mentions tab's count. */
      unreadMentionItemCount: counts.unreadMentionItemCount,
      /**
       * How many items the All view lists, pinned conversations included, whatever the filter:
       * the header's "N active".
       */
      activeItemCount: counts.activeItemCount,
      /** Where the next page starts, or null on the last page. */
      nextCursor: last
        ? ({
            at: last.latestAt.getTime(),
            sequence: last.latestSequence,
            key: last.key!,
          } satisfies ActivityInboxCursor)
        : null,
      /** When this list was read: Mark all read reads through it, and no further. */
      loadedAt: loadedAt.getTime(),
    };
  }

  /**
   * Marks one item Done through the newest message the viewer saw (`throughSequence`), and reads
   * it through the same message: a message that arrived after the viewer's render keeps the item
   * listed and unread. The boundary only moves forward and is clamped to the item's newest
   * message.
   */
  async markDone(workspaceId: string, userId: string, item: ActivityItemDone) {
    return markActivityDone(this.db, this.realtime, workspaceId, userId, item);
  }

  /** Whether the viewer has any unread activity: all the nav rail's Activity dot shows
   * (`navHasUnread`). */
  async navAttention(workspaceId: string, userId: string) {
    await this.authorize(workspaceId, userId);
    return { hasUnread: await navHasUnread(this.db, workspaceId, userId) };
  }

  /** Reads or unreads a mention the viewer was notified of; it stays listed until Done. */
  async setMentionRead(workspaceId: string, userId: string, resolutionId: string, read: boolean) {
    await this.authorize(workspaceId, userId);
    await this.db.pendingMentionAction.updateMany({
      where: { id: resolutionId, workspaceId, targetUserId: userId, notifiedAt: { not: null } },
      data: { targetReadAt: read ? new Date() : null },
    });
    await announceActivityAttention(this.db, this.realtime, workspaceId, userId);
  }

  /**
   * Reads every joined conversation and every thread the inbox lists, through the newest message
   * posted at or before `before` (the list's `loadedAt`), in one transaction. Items stay listed;
   * only Done removes them.
   */
  async markAllRead(workspaceId: string, userId: string, options: { before: Date }) {
    return markActivityAllRead(this.db, this.realtime, workspaceId, userId, options);
  }

  private authorize(workspaceId: string, userId: string) {
    return requireWorkspaceMember(this.db, workspaceId, userId);
  }

  /** Loads the messages, DM peers (Agents and members), channel avatar members and tasks one page
   * of items renders, in a fixed number of queries. */
  private async hydrate(workspaceId: string, userId: string, page: readonly ActivityCandidate[]) {
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
      this.db.message.findMany({
        where: { id: { in: [...messageIds] }, workspaceId },
        // A card's row reads in the viewer's language, not as its stored English body.
        select: { ...browserMessageFields, actionCard: ACTION_CARD_PREVIEW_SELECT },
      }),
      this.db.agent.findMany({
        where: { id: { in: [...agentIds] }, workspaceId },
        select: { id: true, name: true, displayName: true, avatarMascot: true },
      }),
      // By the key, not a membership: the member stays named after leaving the Workspace.
      this.db.user.findMany({
        where: { id: { in: [...new Set(peerUserIds.values())] } },
        select: peoplePeerUserFields,
      }),
      // The members a channel's group avatar shows, as on the Chat sidebar's row.
      channelListMembers(this.db, workspaceId, [...channelIds]),
      this.db.task.findMany({
        where: { messageId: { in: rootIds }, workspaceId },
        select: {
          messageId: true,
          number: true,
          status: true,
          owner: {
            select: {
              user: { select: { username: true, displayName: true } },
              agent: { select: { name: true, displayName: true, deletedAt: true } },
            },
          },
        },
      }),
    ]);
    const settledMessages = await attachForwardedAccess(
      this.db,
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
          avatarUrl: agentAvatarUrl(agent.id, agent.avatarMascot),
        },
      ]),
    );
    const personById = new Map(
      people.map((person) => [person.id, peoplePeer(workspaceId, person)]),
    );
    const taskByRoot = new Map(
      tasks.map((task) => [
        task.messageId,
        {
          number: task.number,
          status: storedTaskStatus(task.status),
          ownerName: task.owner ? browserSenderName(task.owner) : null,
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
              members:
                channelMembers.get(candidate.task?.boardId ?? candidate.conversationId) ?? [],
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
}

/** A candidate from its page row. */
function activityCandidate({
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
