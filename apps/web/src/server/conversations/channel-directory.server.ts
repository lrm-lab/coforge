import { compareChannelNames } from "#src/features/conversations/channel-signals";
import { AppError } from "#src/lib/app-error";
import { requireWorkspaceMember } from "#src/server/workspaces/workspace-membership.server";
import { ACTIVE_MEMBER_WHERE } from "./active-member.server";
import type { PublicChannelPorts } from "./channel-access.server";
import { canListArchivedChannels, resolveActorServerRole } from "./channel-authority.server";
import { isClosedAndUnpinned } from "./channel-closed.server";
import { visibleChannelWhere } from "./channel-read-access.server";
import { channelListPreviews } from "./channel-list-preview.server";
import { channelInfoOf } from "./conversation-realtime.server";
import { HUMAN_UNREAD_MESSAGE_SQL } from "./human-unread.server";

/** The Workspace's channels as lists: every name the composer may reference, the viewer's Chat
 * list with unread counts and previews, and the archived ones Workspace settings shows. */

/**
 * Every channel of the Workspace by id and current name, closed and archived ones included: the
 * authority a body's channel references are checked against before they link (see
 * `rehypeReferenceChips`), and what the composer's `#` list offers, with each channel's
 * description and archived flag for its row. A private channel is listed only to its members.
 */
export async function channelNames(
  { db }: PublicChannelPorts,
  workspaceId: string,
  userId: string,
) {
  await requireWorkspaceMember(db, workspaceId, userId);
  const channels = await db.conversation.findMany({
    where: visibleChannelWhere(workspaceId, { userId }),
    select: { id: true, channelName: true, description: true, archivedAt: true },
  });
  return channels.map((channel) => ({ id: channel.id, ...channelInfoOf(channel) }));
}

export async function listChannels(
  { db }: PublicChannelPorts,
  workspaceId: string,
  userId: string,
) {
  await requireWorkspaceMember(db, workspaceId, userId);
  const channelRows = db.conversation.findMany({
    where: visibleChannelWhere(workspaceId, { userId }),
    orderBy: { channelName: "asc" },
    select: {
      id: true,
      channelName: true,
      archivedAt: true,
      members: {
        where: { userId, ...ACTIVE_MEMBER_WHERE },
        select: {
          id: true,
          channelMuted: true,
          // Slack-style unread cursor. Thread replies belong to their thread
          // target and never advance it, so they never count in the channel badge.
          readThroughSequence: true,
          // Forced unread (`mark as unread`) and per-member hide/close, plus this member's
          // pin order — the three member-level facts the conversation list renders (#121/#122).
          unreadFromSequence: true,
          hiddenAt: true,
          pins: { select: { sortOrder: true } },
        },
      },
    },
  });
  // One query for every channel's unread: other-authored top-level messages past the
  // member's own read cursor, or from their mark-as-unread marker when that is lower.
  // System messages (no sender member) and the viewer's own messages are already-read by
  // definition; a soft-left membership has no badge. The count is a LATERAL per membership
  // with a single lower bound, so it is an index range on `messages(conversationId,
  // sequence)` covering only the unread tail; a plain join (or an OR of the two bounds)
  // lets the planner hash-join every message in the Workspace's channels instead.
  // `arrivedSinceClosed` counts the unread ones posted after the member closed the chat:
  // any of them brings a closed chat back to the list.
  // `mentioned` is true when one of those unread top-level messages mentions this member row.
  const unreadRows = db.$queryRaw<
    {
      conversationId: string;
      unread: number;
      arrivedSinceClosed: number;
      mentioned: boolean;
    }[]
  >`
      SELECT cm."conversationId" AS "conversationId", unread."count" AS "unread",
        unread."arrivedSinceClosed" AS "arrivedSinceClosed",
        unread."mentioned" AS "mentioned"
      FROM "conversation_members" cm
      JOIN "conversations" c
        ON c."id" = cm."conversationId"
       AND c."workspaceId" = ${workspaceId}::uuid
       AND c."channelName" IS NOT NULL
       AND c."hiddenFromWorkspaceAt" IS NULL
      CROSS JOIN LATERAL (
        SELECT COUNT(*)::int AS "count",
          COUNT(*) FILTER (WHERE m."createdAt" > cm."hiddenAt")::int AS "arrivedSinceClosed",
          COALESCE(BOOL_OR(EXISTS (
            SELECT 1 FROM "message_mentions" mm
            WHERE mm."messageId" = m."id" AND mm."memberId" = cm."id"
          )), false) AS "mentioned"
        FROM "messages" m
        WHERE m."conversationId" = cm."conversationId"
          AND m."threadRootId" IS NULL
          AND ${HUMAN_UNREAD_MESSAGE_SQL}
      ) unread
      WHERE cm."userId" = ${userId}::uuid
        AND cm."leftAt" IS NULL
        AND cm."workspaceId" = ${workspaceId}::uuid
  `;
  // The channel previews need only the channel ids. A channel the viewer closed and did not pin
  // is listed only when a newer message reopens it, so the other channels' previews load in
  // parallel with the unread read, and the reopened closed ones are read after it.
  const [channels, unread, previews] = await Promise.all([
    channelRows,
    unreadRows,
    channelRows.then((rows) =>
      channelListPreviews(
        db,
        workspaceId,
        rows.filter((row) => !isClosedAndUnpinned(row)).map((row) => row.id),
        userId,
      ),
    ),
  ]);
  const unreadByConversation = new Map(unread.map((row) => [row.conversationId, row.unread]));
  const mentionedConversations = new Set(
    unread.filter((row) => row.mentioned).map((row) => row.conversationId),
  );
  const reopenedByActivity = new Set(
    unread.filter((row) => row.arrivedSinceClosed > 0).map((row) => row.conversationId),
  );
  const reopenedIds = channels
    .filter((channel) => isClosedAndUnpinned(channel) && reopenedByActivity.has(channel.id))
    .map((channel) => channel.id);
  if (reopenedIds.length) {
    const reopened = await channelListPreviews(db, workspaceId, reopenedIds, userId);
    for (const [id, preview] of reopened) previews.set(id, preview);
  }
  return channels
    .map((channel) => {
      const member = channel.members[0];
      // `.at(0)`, not `[0]`: the pinned row is genuinely optional and the type has to say so,
      // or the row's `pinSortOrder` narrows to `number` and cannot hold "not pinned".
      const pin = member?.pins.at(0);
      const preview = previews.get(channel.id);
      // A non-member (or soft-left viewer) sees no unread badge: the channel's history is
      // readable, but nothing new is "for them" until they join.
      return {
        id: channel.id,
        name: channel.channelName!,
        joined: Boolean(member),
        archived: channel.archivedAt !== null,
        muted: member?.channelMuted ?? false,
        unreadCount: member ? (unreadByConversation.get(channel.id) ?? 0) : 0,
        mentioned: member ? mentionedConversations.has(channel.id) : false,
        lastMessage: preview?.lastMessage ?? null,
        members: preview?.members ?? [],
        /// A closed chat disappears from this member's list only (see `hiddenAt` in the schema);
        /// the conversation itself stays readable, including through its own URL. A new message
        /// from someone else brings it back.
        hidden: member?.hiddenAt != null && !reopenedByActivity.has(channel.id),
        pinned: Boolean(member?.pins.length),
        pinSortOrder: pin ? pin.sortOrder : null,
      };
    })
    .filter(
      // A closed chat leaves the list unless it is pinned: Pinned keeps every pin.
      (channel) => !channel.hidden || channel.pinned,
    )
    .sort(
      // #general first, then by name, as the sidebar keeps a channel event's row
      // (`compareChannelNames`). Pinned rows are ordered by `pinSortOrder` in the sidebar's
      // Pinned section, which merges them with pinned DMs.
      (a, b) => compareChannelNames(a.name, b.name),
    );
}

/**
 * Every archived channel of the Workspace, for Workspace settings: the most recently archived
 * first, then by name. Owner/admin only (`canListArchivedChannels`); each one is unarchived
 * through `setArchived`.
 */
export async function archivedChannels(
  { db }: PublicChannelPorts,
  workspaceId: string,
  userId: string,
) {
  const serverRole = await resolveActorServerRole(db, workspaceId, { userId });
  if (!canListArchivedChannels(serverRole)) throw new AppError("ACCESS_DENIED");
  const channels = await db.conversation.findMany({
    where: { ...visibleChannelWhere(workspaceId, { userId }), archivedAt: { not: null } },
    orderBy: [{ archivedAt: "desc" }, { channelName: "asc" }],
    select: { id: true, channelName: true, archivedAt: true },
  });
  return channels.map((channel) => ({
    id: channel.id,
    name: channel.channelName!,
    archivedAt: channel.archivedAt!,
  }));
}
