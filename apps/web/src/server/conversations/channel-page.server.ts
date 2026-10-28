import type { PrismaClient } from "#src/generated/prisma/client";
import { windowPageFlags } from "#src/lib/conversation-window";
import { canCreateAgents } from "#src/server/workspaces/member-role.server";
import { ACTIVE_MEMBER_WHERE } from "./active-member.server";
import { memberChannel, viewerChannel, type PublicChannelPorts } from "./channel-access.server";
import {
  canDeleteChannel,
  canHideGeneralChannel,
  deriveChannelAuthority,
} from "./channel-authority.server";
import {
  MENTIONABLE_MEMBER_SELECT,
  mentionables,
  viewerRecentMentions,
} from "./channel-mentionables.server";
import {
  browserMessageFields,
  browserMessageUpdates,
  mapBrowserMessage,
} from "./conversation-history.server";
import { othersReadThroughSequence } from "./conversation-read-state.server";
import { mentionAffinityScores } from "./mentions.server";
import { followedThreadRootIds, readWindowThreads } from "./thread-summaries.server";

/** A channel's page as a Workspace member opens it: one window of top-level messages with their
 * threads as summaries, the viewer's own state in the channel, and what they may do there; and
 * the messages that arrived after a window. */

/** The viewer's own member row in a channel, whether or not they left it, with everything an
 * open shows them from it. `openChannel` reads it alongside the channel, not after it. */
function viewerMemberRow(db: PrismaClient, channelId: string, userId: string) {
  return db.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId: channelId, userId } },
    include: {
      // Every thread the viewer ever read or followed here, so only the columns the page sends.
      threadReads: { select: { rootMessageId: true, readThroughSequence: true } },
      threadFollows: { select: { rootMessageId: true } },
      user: { select: { username: true } },
      pins: { select: { sortOrder: true } },
    },
  });
}

export async function openChannel(
  { db }: PublicChannelPorts,
  workspaceId: string,
  userId: string,
  channelId: string,
  page: { beforeSequence?: number; afterSequence?: number; limit?: number } = {},
) {
  const [{ channel, serverRole }, viewerRow] = await Promise.all([
    viewerChannel(db, workspaceId, userId, channelId),
    viewerMemberRow(db, channelId, userId),
  ]);
  // Only an active row (ACTIVE_MEMBER_WHERE): a human who left or was removed sees the read-only
  // preview (`senderMemberId` empty) like anyone who never joined, not their old member state.
  // The row itself survives untouched for a later rejoin.
  const member = viewerRow?.leftAt === null ? viewerRow : undefined;
  // What the settings panel offers this viewer: edit, archive, leave.
  const authority = deriveChannelAuthority({ userId }, channel, serverRole, member);
  const limit = Math.min(page.limit ?? 50, 100);
  // A forward fetch reads towards the live end from the newest sequence the retained window still
  // holds; a backward fetch reads history upwards. Neither is the initial (uncursored) load,
  // which lands on the newest page (see `lib/conversation-window.ts`).
  const forward = page.afterSequence !== undefined;
  const [messages, mentionRows, recentMentions] = await Promise.all([
    db.message.findMany({
      where: {
        conversationId: channelId,
        threadRootId: null,
        sequence: forward
          ? { gt: page.afterSequence }
          : page.beforeSequence
            ? { lt: page.beforeSequence }
            : undefined,
      },
      // Both directions take `limit + 1` rows to learn whether one more remains; the page is
      // re-sorted by sequence below, so only the overflow row's presence matters.
      orderBy: { sequence: forward ? ("asc" as const) : ("desc" as const) },
      take: limit + 1,
      select: browserMessageFields,
    }),
    // The composer's @-completion source: every other active member's public profile.
    db.conversationMember.findMany({
      where: { conversationId: channelId, ...ACTIVE_MEMBER_WHERE },
      select: {
        id: true,
        readThroughSequence: true,
        agentReadThroughSequence: true,
        ...MENTIONABLE_MEMBER_SELECT,
      },
    }),
    // Scores each completion candidate by the viewer's own recent mentions here.
    viewerRecentMentions(db, viewerRow?.id),
  ]);
  const mentionScores = mentionAffinityScores(recentMentions);
  const activeCoordinator =
    channel.coordinatorAgent &&
    mentionRows.some((row) => row.agent?.id === channel.coordinatorAgent?.id)
      ? channel.coordinatorAgent
      : undefined;
  const overflow = messages.length > limit;
  const { hasOlder, hasNewer } = windowPageFlags(
    forward ? "forward" : page.beforeSequence ? "backward" : "initial",
    overflow,
  );
  // The overflow row is always the newest of the fetched rows, so dropping the tail of the
  // ordered list keeps the reader's side of the window and drops the row that only proved there
  // was more.
  const fetched = messages.slice(0, limit);
  const pageMessages = forward ? fetched : fetched.reverse();
  // Each thread of the page as a summary, and the viewer's cursors and follows for these roots
  // only: a long-lived channel's whole history of them never rides along with a page.
  const rootIds = pageMessages.map((message) => message.id);
  const [{ threads, threadReadThrough }, followedRootIds] = await Promise.all([
    readWindowThreads(db, {
      workspaceId,
      conversationId: channelId,
      rootIds,
      viewerMemberId: member?.id,
    }),
    followedThreadRootIds(db, { viewerMemberId: member?.id, rootIds }),
  ]);
  return {
    conversationId: channel.id,
    name: channel.channelName!,
    description: channel.description,
    archived: channel.archivedAt !== null,
    project: channel.project ?? undefined,
    coordinatorAgent: activeCoordinator,
    senderMemberId: member?.id ?? "",
    viewerId: member ? userId : undefined,
    muted: member?.channelMuted ?? false,
    collapseLongMessages: member?.collapseLongMessages ?? true,
    pinned: Boolean(member?.pins.length),
    channelCapabilities: authority.capabilities,
    // Only a Workspace owner or admin hides #general (`setGeneralHidden`), whatever their role in it.
    canHideGeneral: canHideGeneralChannel(channel.channelName!, authority.serverRole),
    canDelete: canDeleteChannel(channel.channelName!, authority.serverRole),
    // The add view's "Create Agent" (`ManageAgents.create`'s rule).
    canCreateAgents: canCreateAgents(authority.serverRole),
    // Any member of a live channel stops its Agents (`ChannelAgentControl.stopAll`).
    canStopAgents: authority.isActiveMember && channel.archivedAt === null,
    // The viewer's conversation-level read cursor over top-level messages:
    // the client positions the initial view at the first unread message and draws the
    // divider there. Undefined for a non-member (nothing is "unread for them").
    readThroughSequence: member?.readThroughSequence,
    ...(member
      ? {
          othersReadThroughSequence: othersReadThroughSequence(member.id, mentionRows),
        }
      : {}),
    threads,
    threadReadThrough,
    followedThreadRootIds: followedRootIds,
    // Every active member, the viewer included: this list is what *resolves* a stored mention
    // token, and a mention of the viewer is the most common one to render — leaving their row
    // out leaked the raw `<@human:uuid>` token in their own view. The composer's rule that you
    // never mention yourself is applied where it belongs, in the composer's candidate list.
    mentionables: mentionables(workspaceId, mentionRows, mentionScores),
    hasOlder,
    hasNewer,
    messages: pageMessages.map((message) => mapBrowserMessage(message, workspaceId)),
  };
}

export async function channelUpdates(
  { db }: PublicChannelPorts,
  workspaceId: string,
  userId: string,
  channelId: string,
  afterSequence: number,
  afterReplySequence?: number,
) {
  await memberChannel(db, workspaceId, userId, channelId);
  const messages = await browserMessageUpdates(db, channelId, afterSequence, afterReplySequence);
  return messages.map((message) => mapBrowserMessage(message, workspaceId));
}
