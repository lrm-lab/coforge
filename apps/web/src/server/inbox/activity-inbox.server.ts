import type { PrismaClient } from "#src/generated/prisma/client";
import type {
  ActivityInboxFilter,
  ActivityItemDone,
} from "#src/features/inbox/activity-inbox.schemas";
import { agentAvatarUrl } from "#src/features/agents/agent-mascot";
import { channelListMembers } from "#src/server/conversations/channel-list-preview.server";
import type { ConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import {
  browserMessageFields,
  mapBrowserMessage,
} from "#src/server/conversations/conversation-history.server";
import { browserSenderName } from "#src/server/conversations/sender-display.server";
import { markActivityAllRead, markActivityDone } from "./activity-inbox-writes.server";
import {
  peoplePeer,
  peoplePeerUserFields,
} from "#src/server/conversations/direct-conversation-peer.server";
import { peopleDirectPeerId } from "#src/features/conversations/direct-key";
import { storedTaskStatus } from "#src/server/tasks/task-view.server";
import { clampPageLimit } from "#src/server/db/page-limit.server";
import { requireWorkspaceMember } from "#src/server/workspaces/workspace-membership.server";
import {
  conversationCandidatesSql,
  navHasUnreadSql,
  threadCandidatesSql,
} from "./activity-inbox-items-sql.server";

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
 * Unread is the Chat sidebar's rule (`HUMAN_UNREAD_MESSAGE_SQL`), so the two surfaces agree. A
 * conversation item covers top-level messages only; a thread item covers its replies and keeps its
 * read and Done boundaries in `thread_reads`. Every cursor write is the conversation module's
 * shared SQL (`human-unread.server.ts`).
 */

/** One conversation or thread with activity, as the candidate query returns it. */
type ActivityCandidate = {
  kind: "channel" | "direct";
  memberId: string;
  conversationId: string;
  rootMessageId: string | null;
  channelName: string | null;
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
   * Mentions and opens there. Null when nothing past Done mentions them.
   */
  firstMentionMessageId: string | null;
  /** A mention the viewer was notified of from outside the channel, until they mark it Done. */
  mentionAction?: { resolutionId: string; threadRootId: string | null };
  /** Whether the item has activity past Done; a pinned conversation is returned without it. */
  pastDone: boolean;
  /** A conversation's own item the viewer pinned: its place among their pins. Null otherwise. */
  pin: { order: number; at: Date } | null;
};

type PinnedCandidate = ActivityCandidate & { pin: NonNullable<ActivityCandidate["pin"]> };

/** A candidate as the grouped statements return it, with the pin as its two columns. */
type ActivityCandidateRow = Omit<ActivityCandidate, "pin"> & {
  pinOrder: number | null;
  pinnedAt: Date | null;
};

const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;

export type ActivityInboxItem = Awaited<ReturnType<ActivityInbox["list"]>>["items"][number];

export class ActivityInbox {
  constructor(
    private readonly db: PrismaClient,
    private readonly realtime?: Pick<ConversationRealtime, "viewerChanged">,
  ) {}

  /** One page of a view, newest activity first, with the Unread and Mentions counts. */
  async list(
    workspaceId: string,
    userId: string,
    options: { filter: ActivityInboxFilter; offset?: number; limit?: number },
  ) {
    await this.authorize(workspaceId, userId);
    // Read before the list, on the clock message `createdAt` values come from: Prisma fills them in
    // this process (`@default(now())` is generated client-side).
    const loadedAt = new Date();
    // Every candidate carries its unread and mention state: the filters select on them and the
    // Unread and Mentions counts cover every item, whichever filter is showing.
    const all = await this.candidates(workspaceId, userId);
    const inboxCandidates = all.filter((candidate) => candidate.pastDone);
    const candidates = inboxCandidates.filter((candidate) =>
      options.filter === "unread"
        ? candidate.unreadCount > 0
        : options.filter === "mentions"
          ? candidate.firstMentionMessageId !== null
          : candidate.pin === null,
    );
    candidates.sort(
      (left, right) =>
        right.latestAt.getTime() - left.latestAt.getTime() ||
        right.latestSequence - left.latestSequence,
    );
    const offset = Math.max(0, options.offset ?? 0);
    const limit = clampPageLimit(options.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const end = offset + limit;
    const pins =
      options.filter === "all" && offset === 0
        ? all
            .filter((candidate): candidate is PinnedCandidate => candidate.pin !== null)
            .sort(
              (left, right) =>
                left.pin.order - right.pin.order || left.pin.at.getTime() - right.pin.at.getTime(),
            )
        : [];
    const [items, pinned] = await Promise.all([
      this.hydrate(workspaceId, userId, candidates.slice(offset, end)),
      pins.length > 0 ? this.hydrate(workspaceId, userId, pins) : [],
    ]);
    return {
      items,
      /**
       * The viewer's pinned conversations in their pin order, on the All view's first page only
       * (empty otherwise): listed whatever their Done boundary, with the item's usual fields.
       */
      pinned,
      /** How many items have something unread, whatever the filter: the Unread tab's count. */
      unreadItemCount: inboxCandidates.filter((candidate) => candidate.unreadCount > 0).length,
      /** How many items have an unread mention, whatever the filter: the Mentions tab's count. */
      unreadMentionItemCount: inboxCandidates.filter((candidate) => candidate.unreadMention).length,
      /**
       * How many items the All view lists, pinned conversations included, whatever the filter:
       * the header's "N active".
       */
      activeItemCount: all.filter((candidate) => candidate.pin !== null || candidate.pastDone)
        .length,
      /** Where the next page starts in the list, or null on the last page. */
      nextOffset: end < candidates.length ? end : null,
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

  /** Whether the viewer has any unread activity: all the nav rail's Activity dot shows. Every online
   * viewer re-reads it on each Workspace message; `navHasUnreadSql` says what it reads. */
  async navAttention(workspaceId: string, userId: string) {
    await this.authorize(workspaceId, userId);
    const [{ hasUnread }] = await this.db.$queryRaw<[{ hasUnread: boolean }]>(
      navHasUnreadSql(workspaceId, userId),
    );
    return { hasUnread };
  }

  /** Reads or unreads a mention the viewer was notified of; it stays listed until Done. */
  async setMentionRead(workspaceId: string, userId: string, resolutionId: string, read: boolean) {
    await this.authorize(workspaceId, userId);
    await this.db.pendingMentionAction.updateMany({
      where: { id: resolutionId, workspaceId, targetUserId: userId, notifiedAt: { not: null } },
      data: { targetReadAt: read ? new Date() : null },
    });
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

  /**
   * Every listed item, and every pinned conversation, with its counts, in grouped statements
   * driven from the viewer's own memberships, so each message range is an index condition on
   * `messages(conversationId, threadRootId, sequence)` rather than a Workspace-wide scan.
   */
  private async candidates(workspaceId: string, userId: string): Promise<ActivityCandidate[]> {
    // Three independent reads: a list is built from top-level items, thread items and mention
    // items, and none of them depends on the others. Starting them together means the page waits
    // for the slowest instead of for two waves.
    const [conversations, threads, mentions] = await Promise.all([
      this.db.$queryRaw<ActivityCandidateRow[]>(conversationCandidatesSql(workspaceId, userId)),
      this.db.$queryRaw<ActivityCandidateRow[]>(threadCandidatesSql(workspaceId, userId)),
      this.mentionCandidates(workspaceId, userId),
    ]);
    return [...conversations, ...threads].map(activityCandidate).concat(mentions);
  }

  /**
   * Each message whose sender had the viewer notified of a mention from outside its channel, until
   * the viewer marks it Done: one mention item per notification, listed from when it was sent,
   * unread until the viewer reads it. Not in a hidden or archived channel.
   */
  private async mentionCandidates(workspaceId: string, userId: string) {
    const rows = await this.db.pendingMentionAction.findMany({
      where: {
        workspaceId,
        targetUserId: userId,
        notifiedAt: { not: null },
        dismissedAt: null,
        message: { conversation: { archivedAt: null, hiddenFromWorkspaceAt: null } },
      },
      select: {
        id: true,
        conversationId: true,
        messageId: true,
        notifiedAt: true,
        targetReadAt: true,
        message: {
          select: {
            sequence: true,
            threadRootId: true,
            conversation: { select: { channelName: true } },
          },
        },
      },
    });
    return rows.map((row): ActivityCandidate => ({
      kind: "channel",
      memberId: "",
      conversationId: row.conversationId,
      rootMessageId: null,
      channelName: row.message.conversation.channelName,
      directKey: null,
      agentId: null,
      latestMessageId: row.messageId,
      latestSequence: row.message.sequence,
      latestAt: row.notifiedAt!,
      unreadCount: row.targetReadAt ? 0 : 1,
      firstUnreadMessageId: row.targetReadAt ? null : row.messageId,
      unreadMention: !row.targetReadAt,
      firstMentionMessageId: row.messageId,
      mentionAction: { resolutionId: row.id, threadRootId: row.message.threadRootId },
      pastDone: true,
      pin: null,
    }));
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
      if (candidate.kind === "channel") channelIds.add(candidate.conversationId);
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
        select: browserMessageFields,
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
    const messageById = new Map(
      messages.map((message) => [message.id, mapBrowserMessage(message, workspaceId)]),
    );
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
              conversationId: candidate.conversationId,
              channelName: candidate.channelName ?? "",
              members: channelMembers.get(candidate.conversationId) ?? [],
            }
          : peer
            ? { kind: "direct" as const, conversationId: candidate.conversationId, peer }
            : null;
      const root = candidate.rootMessageId ? messageById.get(candidate.rootMessageId) : null;
      // A row deleted between the two reads leaves the page rather than rendering half an item.
      if (!latest || !place || root === undefined) return [];
      return [
        {
          key: activityItemKey(candidate),
          place,
          // A channel thread is listed because the viewer follows it; a direct-message thread
          // has no follow switch.
          thread: root ? { root, task: taskByRoot.get(root.id) ?? null } : null,
          latest,
          latestSequence: candidate.latestSequence,
          unreadCount: candidate.unreadCount,
          firstUnreadMessageId: candidate.firstUnreadMessageId,
          unreadMention: candidate.unreadMention,
          firstMentionMessageId: candidate.firstMentionMessageId,
          mentionAction: candidate.mentionAction ?? null,
          /** The viewer pinned this conversation, in whichever view lists it. */
          pinned: candidate.pin !== null,
        },
      ];
    });
  }
}

/** A candidate from its statement row, its two pin columns joined into one pin. */
function activityCandidate({
  pinOrder,
  pinnedAt,
  ...row
}: ActivityCandidateRow): ActivityCandidate {
  return {
    ...row,
    pin: pinOrder !== null && pinnedAt !== null ? { order: pinOrder, at: pinnedAt } : null,
  };
}

/** An item's key on the page: its mention notification, its thread, or its conversation. */
function activityItemKey(candidate: ActivityCandidate) {
  return candidate.mentionAction
    ? `mention:${candidate.mentionAction.resolutionId}`
    : candidate.rootMessageId
      ? `thread:${candidate.rootMessageId}`
      : `conversation:${candidate.conversationId}`;
}
