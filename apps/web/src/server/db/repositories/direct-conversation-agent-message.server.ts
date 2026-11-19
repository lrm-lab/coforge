import type { ForwardCopy } from "#src/server/conversations/message-forward-view.server";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import type { MessageTaskMetadata, TaskStatus } from "@lrm/coforge-sdk/internal";
import { isAttachmentCommentAnchor } from "@lrm/coforge-sdk/agent";
import type { AttachmentMetadata } from "./direct-conversation.repositories.server";
import { humanLabel, type HumanNames } from "#src/lib/human-label";
import {
  agentMessageSender,
  MESSAGE_SENDER_SELECT,
} from "#src/server/conversations/sender-display.server";
import {
  agentMessageView,
  type StoredAgentForward,
} from "#src/server/conversations/agent-message-view.server";
import {
  MESSAGE_MENTIONS_SELECT,
  type MessageMentionRef,
} from "#src/server/conversations/mentions.server";
import { channelTarget } from "#src/server/conversations/agent-delivery.server";
import {
  APP_EVENTS_KIND,
  systemEventTargetFromDirectKey,
} from "#src/server/app-agent-events/app-event-target.server";
import type { DirectTargetOf, TargetConversation } from "./agent-peer-direct.repositories.server";
const TASK_METADATA_SELECT = {
  select: {
    number: true,
    status: true,
    deletedAt: true,
    owner: {
      select: {
        user: { select: { username: true, displayName: true } },
        agent: { select: { name: true, displayName: true, deletedAt: true } },
      },
    },
  },
} satisfies NonNullable<Prisma.MessageInclude["task"]>;
const ACTION_CARD_STATE_SELECT = {
  select: {
    state: true,
    kind: true,
    result: true,
    committedByUser: { select: { username: true } },
  },
} satisfies NonNullable<Prisma.MessageInclude["actionCard"]>;
export const AGENT_FORWARD_SELECT = {
  orderBy: { position: "asc" },
  select: {
    sourceConversationName: true,
    sourceThreadRootId: true,
    sourceSenderHandle: true,
    sourceCreatedAt: true,
    sourceBody: true,
  },
} satisfies Prisma.Message$forwardsArgs;
export const AGENT_MESSAGE_INCLUDE = {
  sender: MESSAGE_SENDER_SELECT,
  attachments: { orderBy: { position: "asc" }, omit: { imageWidth: true, imageHeight: true } },
  task: TASK_METADATA_SELECT,
  actionCard: ACTION_CARD_STATE_SELECT,
  mentions: MESSAGE_MENTIONS_SELECT,
  forwards: AGENT_FORWARD_SELECT,
  attachmentComment: { select: { attachmentId: true, anchorType: true, anchorData: true } },
  _count: { select: { replies: true } },
} satisfies Prisma.MessageInclude;
export type DirectConversationMessageRow = Prisma.MessageGetPayload<{
  include: typeof AGENT_MESSAGE_INCLUDE;
}>;
export function deliveryTarget(parent: string, rootId?: string | null) {
  if (!rootId) return parent;
  return `${parent}:${rootId}`;
}
export function conversationTarget(
  conversation: TargetConversation,
  targetOf: DirectTargetOf,
): string {
  if (conversation.taskDiscussionOf)
    return `${conversationTarget(conversation.taskDiscussionOf.conversation, targetOf)}:#${conversation.taskDiscussionOf.number}`;
  if (conversation.attachmentCommentThread)
    return `attachment:${conversation.attachmentCommentThread.attachmentId}`;
  if (conversation.channelName) return channelTarget(conversation.channelName);
  const direct = targetOf(conversation);
  if (direct) return direct;
  if (conversation.kind === APP_EVENTS_KIND) {
    const systemTarget = systemEventTargetFromDirectKey(conversation.directKey);
    if (systemTarget) return systemTarget;
  }
  return `@${undefined}`;
}
export const CONVERSATION_TARGET_MEMBERS = {
  where: { OR: [{ userId: { not: null } }, { agentId: { not: null } }] },
  select: {
    user: { select: { username: true } },
    agent: { select: { id: true, name: true } },
  },
  take: 2,
} satisfies Prisma.Conversation$membersArgs;
export const TARGET_CONVERSATION_SELECT = {
  kind: true,
  channelName: true,
  directKey: true,
  attachmentCommentThread: { select: { attachmentId: true } },
  members: CONVERSATION_TARGET_MEMBERS,
  taskDiscussionOf: {
    select: {
      number: true,
      conversation: {
        select: { channelName: true, directKey: true, members: CONVERSATION_TARGET_MEMBERS },
      },
    },
  },
} satisfies Prisma.ConversationSelect;
export const AGENT_MESSAGE_WITH_TARGET_INCLUDE = {
  ...AGENT_MESSAGE_INCLUDE,
  conversation: { select: TARGET_CONVERSATION_SELECT },
} satisfies Prisma.MessageInclude;
export function messageDeliveryTarget(
  message: {
    threadRootId: string | null;
    attachmentComment?: {
      attachmentId: string;
    } | null;
    conversation: TargetConversation;
  },
  targetOf: DirectTargetOf,
) {
  if (message.attachmentComment)
    return message.conversation.attachmentCommentThread && message.threadRootId
      ? `attachment:${message.attachmentComment.attachmentId}:${message.threadRootId}`
      : `attachment:${message.attachmentComment.attachmentId}`;
  return deliveryTarget(conversationTarget(message.conversation, targetOf), message.threadRootId);
}
function commentAnchor(
  comment:
    | {
        anchorType: string | null;
        anchorData: unknown;
      }
    | null
    | undefined,
) {
  if (comment?.anchorType === null || comment?.anchorType === undefined) return undefined;
  const anchor = { type: comment.anchorType, data: comment.anchorData };
  return isAttachmentCommentAnchor(anchor) ? anchor : undefined;
}
export function toAgentMessage(
  row: Pick<DirectConversationMessageRow, "id" | "sequence" | "body" | "createdAt"> & {
    sender: Parameters<typeof agentMessageSender>[0];
    task: Parameters<typeof messageTask>[0];
    attachments: (AttachmentMetadata & ForwardCopy)[];
    attachmentComment?: {
      attachmentId: string;
      anchorType: string | null;
      anchorData: unknown;
    } | null;
    actionCard?: {
      state: string;
      kind?: string | null;
      result?: unknown;
      committedByUser?: {
        username: string;
      } | null;
    } | null;
    forwards?: StoredAgentForward[];
    mentions?: MessageMentionRef[];
    _count?: {
      replies: number;
    };
  },
  target: string,
  readerAgentId?: string,
  channelCoordination?: string,
) {
  const task = messageTask(row.task);
  const sender = agentMessageSender(row.sender);
  const anchor = commentAnchor(row.attachmentComment);
  return {
    id: row.id,
    sequence: row.sequence,
    senderKind: sender.kind,
    senderHandle: sender.handle,
    senderDescription: sender.description,
    ...agentMessageView(
      {
        body: row.body,
        mentions: row.mentions ?? [],
        actionCard: row.actionCard,
        forwards: row.forwards,
        attachments: row.attachments,
      },
      readerAgentId,
      channelCoordination,
    ),
    createdAt: row.createdAt,
    target,
    attachments: row.attachments.map((item) => {
      const { forwardPosition, ...attachment } = item;
      void forwardPosition;
      return attachment;
    }),
    ...(row._count?.replies ? { replyCount: row._count.replies } : {}),
    ...(task ? { task } : {}),
    ...(anchor ? { attachmentCommentAnchor: anchor } : {}),
  };
}
function taskStatus(value: string): TaskStatus {
  switch (value) {
    case "backlog":
    case "todo":
    case "in_progress":
    case "in_review":
    case "done":
    case "closed":
      return value;
    default:
      throw new Error("invalid persisted Task status");
  }
}
function messageTask(
  task: {
    deletedAt?: Date | null;
    number: number;
    status: string;
    owner: {
      user: HumanNames | null;
      agent: {
        name: string;
        displayName: string;
        deletedAt: Date | null;
      } | null;
    } | null;
  } | null,
): MessageTaskMetadata | undefined {
  if (!task) return undefined;
  if (task.deletedAt)
    return { deleted: true, number: task.number, status: taskStatus(task.status) };
  const agent = task.owner?.agent;
  const user = task.owner?.user;
  const handle = agent ? agent.name : user?.username;
  const displayName = agent ? agent.displayName || handle : user && humanLabel(user);
  return {
    number: task.number,
    status: taskStatus(task.status),
    ...(displayName && handle
      ? {
          owner: {
            displayName,
            handle,
            ...(agent?.deletedAt ? { deleted: true } : {}),
          },
        }
      : {}),
  };
}
export async function readWindowAround(
  db: Pick<PrismaClient, "message">,
  scope: Prisma.MessageWhereInput,
  anchorSequence: number,
  limit: number,
) {
  const beforeCount = Math.floor((limit - 1) / 2);
  const afterCount = limit - 1 - beforeCount;
  const [beforeRows, anchorRows, afterRows] = await Promise.all([
    db.message.findMany({
      where: { ...scope, sequence: { lt: anchorSequence } },
      orderBy: { sequence: "desc" },
      take: beforeCount + 1,
      include: AGENT_MESSAGE_INCLUDE,
    }),
    db.message.findMany({
      where: { ...scope, sequence: anchorSequence },
      take: 1,
      include: AGENT_MESSAGE_INCLUDE,
    }),
    db.message.findMany({
      where: { ...scope, sequence: { gt: anchorSequence } },
      orderBy: { sequence: "asc" },
      take: afterCount + 1,
      include: AGENT_MESSAGE_INCLUDE,
    }),
  ]);
  return {
    rows: [
      ...beforeRows.slice(0, beforeCount).reverse(),
      ...anchorRows,
      ...afterRows.slice(0, afterCount),
    ],
    hasOlder: beforeRows.length > beforeCount,
    hasNewer: afterRows.length > afterCount,
  };
}
export async function readLatestWindow(
  db: Pick<PrismaClient, "message">,
  scope: Prisma.MessageWhereInput,
  limit: number,
) {
  const rows = await db.message.findMany({
    where: scope,
    orderBy: { sequence: "desc" },
    take: limit + 1,
    include: AGENT_MESSAGE_INCLUDE,
  });
  return {
    rows: rows.slice(0, limit).reverse(),
    hasOlder: rows.length > limit,
    hasNewer: false,
    ...(rows.length > limit ? { sequenceBeforePage: rows.at(-1)?.sequence } : {}),
  };
}
export function readPositionReport(
  unread: boolean | undefined,
  isHistoryRead: boolean,
  read: {
    readThrough: number;
    modelSeenUpToSeq?: number | null;
    hasMore?: boolean;
  },
) {
  if (unread)
    return {
      unreadCursorBefore: read.readThrough,
      readPositionAfter: read.modelSeenUpToSeq ?? read.readThrough,
      moreUnread: Boolean(read.hasMore),
    };
  return isHistoryRead ? {} : { unreadCursorBefore: read.readThrough };
}
