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
import type { ActivityPageRow } from "./activity-inbox-page-sql.server";

export type ActivityCandidate = {
  key: string;
  kind: "channel" | "direct";
  memberId: string | null;
  conversationId: string;
  rootMessageId: string | null;
  channelName: string | null;
  visibility: string;
  directKey: string | null;
  agentId: string | null;
  latestMessageId: string;
  latestSequence: number;
  latestAt: Date;
  unreadCount: number;
  firstUnreadMessageId: string | null;
  unreadMention: boolean;
  firstMentionMessageId: string | null;
  mentionAction?: { resolutionId: string; threadRootId: string | null };
  attachmentComment?: {
    attachmentId: string;
    fileName: string;
    threadRootId: string | null;
    sourceMessageId: string | null;
  };
  pin: { order: number; at: Date } | null;
  task?: { boardId: string; number: number; title: string };
};

async function hydrateConversationItems(
  db: PrismaClient,
  workspaceId: string,
  userId: string,
  page: readonly ActivityCandidate[],
) {
  if (page.length === 0) return [];
  const messageIds = new Set<string>();
  const agentIds = new Set<string>();
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
  const uniquePeerUserIds = [...new Set(peerUserIds.values())];
  const [messages, agents, people, channelMembers, tasks] = await Promise.all([
    messageIds.size > 0
      ? db.message.findMany({
          where: { id: { in: [...messageIds] }, workspaceId },
          select: { ...browserMessageFields, actionCard: ACTION_CARD_PREVIEW_SELECT },
        })
      : [],
    agentIds.size > 0
      ? db.agent.findMany({
          where: { id: { in: [...agentIds] }, workspaceId },
          select: {
            id: true,
            name: true,
            displayName: true,
            avatarMascot: true,
            appBot: APP_BOT_LOGO_SELECT,
          },
        })
      : [],
    uniquePeerUserIds.length > 0
      ? db.user.findMany({
          where: { id: { in: uniquePeerUserIds } },
          select: peoplePeerUserFields,
        })
      : [],
    channelIds.size > 0
      ? channelListMembers(db, workspaceId, [...channelIds])
      : new Map<string, never[]>(),
    rootIds.length > 0
      ? db.task.findMany({
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
        })
      : [],
  ]);
  const settledMessages =
    messages.length > 0
      ? await attachForwardedAccess(
          db,
          workspaceId,
          userId,
          messages.map((message) => ({
            ...mapBrowserMessage(message, workspaceId),
            ...previewCardFieldOf(message.actionCard),
          })),
        )
      : [];
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
        ownerFace: task.owner
          ? {
              kind: task.owner.userId ? ("user" as const) : ("agent" as const),
              id: task.owner.userId ?? task.owner.agentId ?? undefined,
              avatarUrl: browserSenderAvatarUrl(task.owner, workspaceId),
            }
          : null,
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
            conversationId: candidate.task?.boardId ?? candidate.conversationId,
            channelName: candidate.channelName ?? "",
            visibility: channelVisibilityOf(candidate),
            members: channelMembers.get(candidate.task?.boardId ?? candidate.conversationId) ?? [],
          }
        : peer
          ? { kind: "direct" as const, conversationId: candidate.conversationId, peer }
          : null;
    const root = candidate.rootMessageId ? messageById.get(candidate.rootMessageId) : null;
    if (!latest || !place || root === undefined) return [];
    return [
      {
        kind: "conversation" as const,
        key: candidate.key,
        place,
        thread: root ? { root, task: taskByRoot.get(root.id) ?? null } : null,
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
        pinned: candidate.pin !== null,
      },
    ];
  });
}

function activityCandidate(row: ActivityPageRow): ActivityCandidate {
  return {
    key: row.key!,
    kind: row.kind,
    memberId: row.memberId,
    conversationId: row.conversationId!,
    rootMessageId: row.rootMessageId,
    channelName: row.channelName,
    visibility: row.visibility,
    directKey: row.directKey,
    agentId: row.agentId,
    latestMessageId: row.latestMessageId!,
    latestSequence: row.latestSequence,
    latestAt: row.latestAt,
    unreadCount: row.unreadCount,
    firstUnreadMessageId: row.firstUnreadMessageId,
    unreadMention: row.unreadMention,
    firstMentionMessageId: row.firstMentionMessageId,
    ...(row.mentionId && {
      mentionAction: {
        resolutionId: row.mentionId,
        threadRootId: row.attachmentId ? null : row.noticeThreadRootId,
      },
    }),
    ...(row.attachmentId && {
      attachmentComment: {
        attachmentId: row.attachmentId,
        fileName: row.attachmentFileName!,
        threadRootId: row.noticeThreadRootId,
        sourceMessageId: row.attachmentSourceMessageId,
      },
    }),
    pin:
      row.pinOrder !== null && row.pinnedAt !== null
        ? { order: row.pinOrder, at: row.pinnedAt }
        : null,
    ...(row.taskBoardId && {
      task: { boardId: row.taskBoardId, number: row.taskNumber!, title: row.taskTitle! },
    }),
  };
}

export type ActivityConversationItem = Awaited<ReturnType<typeof hydrateConversationItems>>[number];

export const hydrateConversationRows = (
  db: PrismaClient,
  workspaceId: string,
  userId: string,
  rows: readonly ActivityPageRow[],
) => hydrateConversationItems(db, workspaceId, userId, rows.map(activityCandidate));
