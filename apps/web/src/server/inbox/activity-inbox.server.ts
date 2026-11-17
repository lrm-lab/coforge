import type { PrismaClient } from "#src/generated/prisma/client";
import type {
  ActivityDoneUndo,
  ActivityInboxCursor,
  ActivityInboxFilter,
  ActivityItemDone,
} from "#src/features/inbox/activity-inbox.schemas";
import {
  markActivityAllRead,
  markActivityDone,
  type ActivityInboxRealtime,
} from "./activity-inbox-writes.server";
import { markActivityAllDone, undoActivityDone } from "./activity-inbox-bulk-writes.server";
import { clampPageLimit } from "#src/server/db/page-limit.server";
import { requireWorkspaceMember } from "#src/server/workspaces/workspace-membership.server";
import { activityPageSql, type ActivityPageRow } from "./activity-inbox-page-sql.server";
import { announceActivityAttention, navHasUnread } from "./activity-attention.server";
import {
  activityCandidate,
  hydrateConversationItems,
} from "./activity-inbox-conversation-hydrate.server";

/**
 * A person's Activity inbox: every joined channel, every direct message of theirs (with their own
 * Agent, another member, or themself: the DMs their Direct messages list holds), every channel
 * thread they follow, and every thread in those direct messages, as long as it has activity past
 * the point where they marked it Done. Reading an item never removes it; Done does, until a newer
 * message arrives. It also lists each message whose sender had them notified of a mention from
 * outside that channel, until they mark it Done. A message between members stores no mentions and
 * notifies nobody outside the DM, so a DM between members only ever lists as itself or a thread.
 * The All view lists the viewer's pinned conversations (the Chat sidebar's Pinned) apart, in pin
 * order, and leaves their conversation items out of its list. They list by the same
 * activity-past-Done rule as every row (Raft's Activity, docs.raft.build/features/messaging/
 * activity: Done takes a row out until something new arrives), so a Done pin leaves with the
 * rest and returns when the conversation has something new, the pin itself untouched.
 *
 * Unread is the Chat sidebar's rule (`HUMAN_UNREAD_BASE_SQL`), so the two surfaces agree. A
 * conversation item covers top-level messages only; a thread item covers its replies and keeps its
 * read and Done boundaries in `thread_reads`. Every cursor write is the conversation module's
 * shared SQL (`human-unread.server.ts`).
 */

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
      hydrateConversationItems(this.db, workspaceId, userId, shown.map(activityCandidate)),
      pins.length > 0
        ? hydrateConversationItems(this.db, workspaceId, userId, pins.map(activityCandidate))
        : [],
    ]);
    return {
      items,
      /**
       * The viewer's pinned conversations in their pin order, on the All view's first page only
       * (empty otherwise), listed by the same activity-past-Done rule as every row, with the
       * item's usual fields.
       */
      pinned,
      /** How many items have something unread, whatever the filter: the Unread tab's count. */
      unreadItemCount: counts.unreadItemCount,
      /** How many items have an unread mention, whatever the filter: the Mentions tab's count. */
      unreadMentionItemCount: counts.unreadMentionItemCount,
      /**
       * How many items the All view lists, pinned conversations included, whatever the filter:
       * the header's "N active". Listed rows only: a Done pin counts out with its row.
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
    return navHasUnread(this.db, workspaceId, userId);
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

  /** Marks everything listed Done through `before`, handing back what Undo needs. */
  async markAllDone(workspaceId: string, userId: string, options: { before: Date }) {
    return markActivityAllDone(this.db, this.realtime, workspaceId, userId, options);
  }

  /** Takes back a Mark all done where nothing newer has changed the rows since. */
  async undoDone(workspaceId: string, userId: string, undo: ActivityDoneUndo) {
    return undoActivityDone(this.db, this.realtime, workspaceId, userId, undo);
  }

  private authorize(workspaceId: string, userId: string) {
    return requireWorkspaceMember(this.db, workspaceId, userId);
  }
}
