import type { PrismaClient } from "#src/generated/prisma/client";
import {
  isMutedLevel,
  readNotificationLevel,
} from "#src/server/conversations/notification-level.server";
import { windowPageFlags } from "#src/lib/conversation-window";
import { channelVisibilityOf } from "#src/features/conversations/channel-visibility";
import { canCreateAgents } from "#src/server/workspaces/member-role.server";
import { ACTIVE_MEMBER_WHERE } from "./active-member.server";
import { memberChannel, viewerChannel, type PublicChannelPorts } from "./channel-access.server";
import {
  canDeleteChannel,
  canChangeChannelVisibility,
  canHideGeneralChannel,
  deriveChannelAuthority,
} from "./channel-authority.server";
import {
  MENTIONABLE_MEMBER_SELECT,
  mentionables,
  viewerRecentMentions,
} from "./channel-mentionables.server";
import { browserMessageUpdates } from "./conversation-history.server";
import { browserMessageFields, mapBrowserMessages } from "./browser-message-projection.server";
import { othersReadThroughSequence } from "./conversation-read-state.server";
import { mentionAffinityScores } from "./mentions.server";
import { followedThreadRootIds, readWindowThreads } from "./thread-summaries.server";
import { mapBrowserMessagesWithViewerViews } from "./viewer-views.server";

function viewerMemberRow(db: PrismaClient, channelId: string, userId: string) {
  return db.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId: channelId, userId } },
    include: {
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
  page: {
    beforeSequence?: number;
    afterSequence?: number;
    limit?: number;
    includeViewerViews?: boolean;
  } = {},
) {
  const [{ channel, serverRole }, viewerRow] = await Promise.all([
    viewerChannel(db, workspaceId, userId, channelId),
    viewerMemberRow(db, channelId, userId),
  ]);
  const member = viewerRow?.leftAt === null ? viewerRow : undefined;
  const authority = deriveChannelAuthority({ userId }, channel, serverRole, member);
  const limit = Math.min(page.limit ?? 50, 100);
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
      orderBy: { sequence: forward ? ("asc" as const) : ("desc" as const) },
      take: limit + 1,
      select: browserMessageFields,
    }),
    db.conversationMember.findMany({
      where: { conversationId: channelId, ...ACTIVE_MEMBER_WHERE },
      select: {
        readThroughSequence: true,
        agentReadThroughSequence: true,
        ...MENTIONABLE_MEMBER_SELECT,
      },
    }),
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
  const fetched = messages.slice(0, limit);
  const pageMessages = forward ? fetched : fetched.reverse();
  const rootIds = pageMessages.map((message) => message.id);
  const [{ threads, threadReadThrough, threadUnreadMarks }, followedRootIds, browserMessages] =
    await Promise.all([
      readWindowThreads(db, {
        workspaceId,
        conversationId: channelId,
        rootIds,
        viewerMemberId: member?.id,
      }),
      followedThreadRootIds(db, { viewerMemberId: member?.id, rootIds }),
      page.includeViewerViews
        ? mapBrowserMessagesWithViewerViews(db, pageMessages, workspaceId, userId, {
            authorizedConversationId: channelId,
          })
        : mapBrowserMessages(db, pageMessages, workspaceId),
    ]);
  return {
    conversationId: channel.id,
    name: channel.channelName!,
    description: channel.description,
    archived: channel.archivedAt !== null,
    visibility: channelVisibilityOf(channel),
    coordinatorAgent: activeCoordinator,
    senderMemberId: member?.id ?? "",
    viewerId: member ? userId : undefined,
    muted: isMutedLevel(member?.notificationLevel),
    notificationLevel: readNotificationLevel(member?.notificationLevel),
    collapseLongMessages: member?.collapseLongMessages ?? false,
    pinned: Boolean(member?.pins.length),
    channelCapabilities: authority.capabilities,
    canHideGeneral: canHideGeneralChannel(channel.channelName!, authority.serverRole),
    canDelete: canDeleteChannel(channel.channelName!, authority.serverRole),
    ...({
      canChangeVisibility:
        channel.archivedAt === null &&
        canChangeChannelVisibility(
          channel.channelName!,
          authority.serverRole,
          authority.isActiveMember,
        ),
    } as { canChangeVisibility?: boolean }),
    canCreateAgents: canCreateAgents(authority.serverRole),
    canStopAgents: authority.isActiveMember && channel.archivedAt === null,
    ...(member
      ? {
          othersReadThroughSequence: othersReadThroughSequence(member.id, mentionRows),
        }
      : {}),
    threads,
    threadReadThrough,
    ...(threadUnreadMarks && { threadUnreadMarks }),
    followedThreadRootIds: followedRootIds,
    mentionables: mentionables(workspaceId, mentionRows, mentionScores),
    hasOlder,
    hasNewer,
    messages: browserMessages,
  };
}

export async function channelUpdates(
  { db }: PublicChannelPorts,
  workspaceId: string,
  userId: string,
  channelId: string,
  afterSequence: number,
  afterReplySequence?: number,
  options?: { includeViewerViews?: boolean },
) {
  await memberChannel(db, workspaceId, userId, channelId);
  const messages = await browserMessageUpdates(db, channelId, afterSequence, afterReplySequence);
  return options?.includeViewerViews
    ? mapBrowserMessagesWithViewerViews(db, messages, workspaceId, userId, {
        authorizedConversationId: channelId,
      })
    : mapBrowserMessages(db, messages, workspaceId);
}
