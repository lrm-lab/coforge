import { activityCursorForFilter } from "#src/features/inbox/activity-inbox.schemas";
import type { PrismaClient } from "#src/generated/prisma/client";
import type {
  ActivityArtifactMark,
  ActivityDoneUndo,
  ActivityInboxCursor,
  ActivityInboxFilter,
  ActivityItemDone,
} from "#src/features/inbox/activity-inbox.schemas";
import {
  markActivityAllRead,
  markActivityArtifactRead,
  markActivityDone,
  type ActivityInboxRealtime,
} from "./activity-inbox-writes.server";
import { markActivityAllDone, undoActivityDone } from "./activity-inbox-bulk-writes.server";
import { clampPageLimit } from "#src/server/db/page-limit.server";
import { requireWorkspaceMember } from "#src/server/workspaces/workspace-membership.server";
import { activityPageSql, type ActivityPageRow } from "./activity-inbox-page-sql.server";
import { hydrateConversationRows } from "./activity-inbox-conversation-hydrate.server";
import { hydrateArtifactItems, isListedArtifact } from "./activity-inbox-artifact-hydrate.server";
import { compareActivityOrder } from "./activity-inbox-order";
import {
  artifactActivityPageSql,
  type ArtifactListedRow,
} from "#src/server/artifacts/artifact-activity.server";
import { announceActivityAttention, navHasUnread } from "./activity-attention.server";

const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;

export type { ActivityConversationItem } from "./activity-inbox-conversation-hydrate.server";
export type { ActivityArtifactItem } from "./activity-inbox-artifact-hydrate.server";
export type ActivityInboxItem = Awaited<ReturnType<ActivityInbox["list"]>>["items"][number];

export class ActivityInbox {
  constructor(
    private readonly db: PrismaClient,
    private readonly realtime: ActivityInboxRealtime,
  ) {}

  async list(
    workspaceId: string,
    userId: string,
    options: {
      filter: ActivityInboxFilter;
      cursor?: ActivityInboxCursor;
      limit?: number;
      selectedKey?: string;
    },
  ) {
    await this.authorize(workspaceId, userId);
    const loadedAt = new Date();
    const unreadFirst = options.filter === "all";
    const cursor = activityCursorForFilter(options.filter, options.cursor);
    const limit = clampPageLimit(options.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const selectedKey = unreadFirst && !cursor ? options.selectedKey : undefined;
    const [rows, artifactRows] = await Promise.all([
      this.db.$queryRaw<ActivityPageRow[]>(
        activityPageSql(workspaceId, userId, {
          selectedKey: selectedKey?.startsWith("artifact:") ? undefined : selectedKey,
          filter: options.filter,
          cursor,
          limit,
        }),
      ),
      this.db.$queryRaw<ArtifactListedRow[]>(
        artifactActivityPageSql(workspaceId, userId, {
          selectedKey: selectedKey?.startsWith("artifact:") ? selectedKey : undefined,
          filter: options.filter,
          cursor,
          limit,
        }),
      ),
    ]);
    const counts = rows[0]!;
    const artifactCounts = artifactRows[0]!;
    const listed = rows.filter((row) => row.key !== null);
    const pins = listed.filter((row) => row.isPin);
    const ordered = [
      ...listed
        .filter((row) => !row.isPin)
        .map((row) => ({
          row,
          key: row.key!,
          latestAt: row.latestAt,
          latestSequence: row.latestSequence,
          hasUnread: unreadFirst && row.hasUnread,
        })),
      ...artifactRows.filter(isListedArtifact).map((row) => ({
        row,
        key: row.key,
        latestAt: row.latestAt,
        latestSequence: 0,
        hasUnread: unreadFirst && row.hasUnread === true,
      })),
    ].sort(compareActivityOrder);
    const shown = ordered.slice(0, limit);
    const last = ordered.length > limit ? shown.at(-1)! : null;
    const extra =
      selectedKey && !shown.some((entry) => entry.key === selectedKey)
        ? ordered.find((entry) => entry.key === selectedKey)
        : undefined;
    const hydrate = extra ? [...shown, extra] : shown;
    const shownArtifacts = hydrate.flatMap(({ row }) => ("artifactId" in row ? [row] : []));
    const [conversations, artifacts, pinned] = await Promise.all([
      hydrateConversationRows(
        this.db,
        workspaceId,
        userId,
        hydrate.flatMap(({ row }) => ("artifactId" in row ? [] : [row])),
      ),
      hydrateArtifactItems(this.db, workspaceId, userId, shownArtifacts),
      pins.length > 0 ? hydrateConversationRows(this.db, workspaceId, userId, pins) : [],
    ]);
    const byKey = new Map<string, (typeof conversations)[number] | (typeof artifacts)[number]>(
      [...conversations, ...artifacts].map((item) => [item.key, item]),
    );
    const missing = shownArtifacts.filter((row) => row.key !== extra?.key && !byKey.has(row.key));
    const without = (count: (row: ArtifactListedRow) => boolean) => missing.filter(count).length;
    return {
      ...(extra ? { selectedItem: byKey.get(extra.key) } : {}),
      items: shown.flatMap(({ key }) => byKey.get(key) ?? []),
      pinned,
      unreadItemCount:
        counts.unreadItemCount +
        artifactCounts.unreadItemCount -
        without((row) => row.hasUnread === true),
      unreadMentionItemCount:
        counts.unreadMentionItemCount +
        artifactCounts.unreadMentionItemCount -
        without((row) => row.unreadMention === true),
      unreadArtifactItemCount:
        artifactCounts.unreadItemCount - without((row) => row.hasUnread === true),
      activeItemCount: counts.activeItemCount + artifactCounts.activeItemCount - missing.length,
      nextCursor: last
        ? ({
            at: last.latestAt.getTime(),
            sequence: last.latestSequence,
            key: last.key,
            ...(unreadFirst
              ? { order: "unread-first-v1" as const, hasUnread: last.hasUnread }
              : {}),
          } satisfies ActivityInboxCursor)
        : null,
      loadedAt: loadedAt.getTime(),
    };
  }

  async markDone(workspaceId: string, userId: string, item: ActivityItemDone) {
    return markActivityDone(this.db, this.realtime, workspaceId, userId, item);
  }

  async markArtifactRead(workspaceId: string, userId: string, item: ActivityArtifactMark) {
    return markActivityArtifactRead(this.db, this.realtime, workspaceId, userId, item);
  }

  async artifactOpened(workspaceId: string, userId: string) {
    await announceActivityAttention(this.db, this.realtime, workspaceId, userId);
  }

  async navAttention(workspaceId: string, userId: string) {
    await this.authorize(workspaceId, userId);
    return navHasUnread(this.db, workspaceId, userId);
  }

  async setMentionRead(workspaceId: string, userId: string, resolutionId: string, read: boolean) {
    await this.authorize(workspaceId, userId);
    await this.db.pendingMentionAction.updateMany({
      where: { id: resolutionId, workspaceId, targetUserId: userId, notifiedAt: { not: null } },
      data: { targetReadAt: read ? new Date() : null },
    });
    await announceActivityAttention(this.db, this.realtime, workspaceId, userId);
  }

  async markAllRead(workspaceId: string, userId: string, options: { before: Date }) {
    return markActivityAllRead(this.db, this.realtime, workspaceId, userId, options);
  }

  async markAllDone(workspaceId: string, userId: string, options: { before: Date }) {
    return markActivityAllDone(this.db, this.realtime, workspaceId, userId, options);
  }

  async undoDone(workspaceId: string, userId: string, undo: ActivityDoneUndo) {
    return undoActivityDone(this.db, this.realtime, workspaceId, userId, undo);
  }

  private authorize(workspaceId: string, userId: string) {
    return requireWorkspaceMember(this.db, workspaceId, userId);
  }
}
