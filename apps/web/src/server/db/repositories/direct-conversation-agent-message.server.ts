import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import type { MessageTaskMetadata, TaskStatus } from "@lrm/coforge-sdk/internal";
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
import type { DirectTargetOf, TargetConversation } from "./agent-peer-direct.repositories.server";

const TASK_METADATA_SELECT = {
  select: {
    number: true,
    status: true,
    owner: {
      select: {
        user: { select: { username: true, displayName: true } },
        agent: { select: { name: true, displayName: true, deletedAt: true } },
      },
    },
  },
} satisfies NonNullable<Prisma.MessageInclude["task"]>;

/** Just the state an Agent needs to know whether a card it prepared has been acted on. */
const ACTION_CARD_STATE_SELECT = {
  select: { state: true },
} satisfies NonNullable<Prisma.MessageInclude["actionCard"]>;

/** The snapshot an Agent reads of a forwarded message (`agentForwarded`). */
export const AGENT_FORWARD_SELECT = {
  select: {
    sourceConversationName: true,
    sourceThreadRootId: true,
    sourceSenderHandle: true,
    sourceCreatedAt: true,
    sourceBody: true,
  },
} satisfies NonNullable<Prisma.MessageInclude["forward"]>;

/** Message projection sent to an Agent. */
export const AGENT_MESSAGE_INCLUDE = {
  memoryHint: { select: { id: true, targetAgentId: true, deliveredAt: true } },
  sender: MESSAGE_SENDER_SELECT,
  attachments: { orderBy: { position: "asc" }, omit: { imageWidth: true, imageHeight: true } },
  task: TASK_METADATA_SELECT,
  actionCard: ACTION_CARD_STATE_SELECT,
  mentions: MESSAGE_MENTIONS_SELECT,
  forward: AGENT_FORWARD_SELECT,
  // The thread's reply count, so a history line can say how many answers a message has.
  _count: { select: { replies: true } },
} satisfies Prisma.MessageInclude;

export type DirectConversationMessageRow = Prisma.MessageGetPayload<{
  include: typeof AGENT_MESSAGE_INCLUDE;
}>;

/** A delivery target is the conversation target, suffixed with the thread root when replying. */
export function deliveryTarget(parent: string, rootId?: string | null) {
  if (!rootId) return parent;
  return `${parent}:${rootId}`;
}

/**
 * `#channel` for a public channel, otherwise the other side of the direct conversation as the
 * reader sees it (`targetOf`, from `directTargets`; required, so a caller cannot forget it). A
 * conversation with neither a person nor an Agent peer is an App's events.
 */
export function conversationTarget(
  conversation: TargetConversation,
  targetOf: DirectTargetOf,
): string {
  // A task's discussion: its board and the task, `#channel:#N` (a task is not a thread root).
  if (conversation.taskDiscussionOf)
    return `${conversationTarget(conversation.taskDiscussionOf.conversation, targetOf)}:#${conversation.taskDiscussionOf.number}`;
  // An attachment's comment discussion: the file's own target (`attachment:<id>`).
  if (conversation.attachmentCommentThread)
    return `attachment:${conversation.attachmentCommentThread.attachmentId}`;
  if (conversation.channelName) return channelTarget(conversation.channelName);
  return targetOf(conversation) ?? `@${undefined}`;
}

/** The members `conversationTarget` names a direct conversation by: its person, or, between two
 * Agents, both Agents. */
export const CONVERSATION_TARGET_MEMBERS = {
  where: { OR: [{ userId: { not: null } }, { agentId: { not: null } }] },
  select: {
    user: { select: { username: true } },
    agent: { select: { id: true, name: true } },
  },
  take: 2,
} satisfies Prisma.Conversation$membersArgs;

/** What `conversationTarget` reads of a conversation, and of the board when it is a task's. */
export const TARGET_CONVERSATION_SELECT = {
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

/** `AGENT_MESSAGE_INCLUDE` plus what `messageDeliveryTarget` reads from the conversation. */
export const AGENT_MESSAGE_WITH_TARGET_INCLUDE = {
  ...AGENT_MESSAGE_INCLUDE,
  conversation: { select: TARGET_CONVERSATION_SELECT },
} satisfies Prisma.MessageInclude;

/** Where a Message is delivered: its conversation's target, with its thread root if it has one. */
export function messageDeliveryTarget(
  message: { threadRootId: string | null; conversation: TargetConversation },
  targetOf: DirectTargetOf,
) {
  return deliveryTarget(conversationTarget(message.conversation, targetOf), message.threadRootId);
}

export function toAgentMessage(
  row: Pick<DirectConversationMessageRow, "id" | "sequence" | "body" | "createdAt"> & {
    sender: Parameters<typeof agentMessageSender>[0];
    task: Parameters<typeof messageTask>[0];
    attachments: AttachmentMetadata[];
    actionCard?: { state: string } | null;
    forward?: StoredAgentForward | null;
    memoryHint?: { id: string; targetAgentId: string; deliveredAt: Date | null } | null;
    mentions?: MessageMentionRef[];
    _count?: { replies: number };
  },
  target: string,
  readerAgentId?: string,
  channelCoordination?: string,
) {
  const task = messageTask(row.task);
  const sender = agentMessageSender(row.sender);
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
        forward: row.forward,
        attachments: row.attachments,
      },
      readerAgentId,
      channelCoordination,
    ),
    createdAt: row.createdAt,
    target,
    attachments: row.attachments,
    ...(row._count?.replies ? { replyCount: row._count.replies } : {}),
    ...(task ? { task } : {}),
    ...(row.memoryHint?.deliveredAt && row.memoryHint.targetAgentId === readerAgentId
      ? { memoryHint: { hint_id: row.memoryHint.id, tool: "memory_disposition" as const } }
      : {}),
  };
}

function taskStatus(value: string): TaskStatus {
  switch (value) {
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
    number: number;
    status: string;
    owner: {
      user: HumanNames | null;
      agent: { name: string; displayName: string; deletedAt: Date | null } | null;
    } | null;
  } | null,
): MessageTaskMetadata | undefined {
  if (!task) return undefined;
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
            // A deleted Agent keeps the Task; the reading Agent must not take it for a live owner.
            ...(agent?.deletedAt ? { deleted: true } : {}),
          },
        }
      : {}),
  };
}

/**
 * The messages around `anchorSequence` in `scope`, oldest first: the anchor, and as many before and
 * after it as `limit` allows (the anchor takes one of the `limit` places, the earlier side takes
 * the smaller half). Reports whether either side had more.
 */
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

/** The newest `limit` messages of `scope`, oldest first, and whether older ones remain (none are
 * newer). */
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

/**
 * Where the Agent's read position stood before a read and where it moved to, for the reads that
 * move it from the position: an unread read reports both and whether more remain, and a plain
 * latest read reports where it started so the CLI can describe a complete-page advance or what
 * lies newer.
 */
export function readPositionReport(
  unread: boolean | undefined,
  isHistoryRead: boolean,
  read: { readThrough: number; modelSeenUpToSeq?: number | null; hasMore?: boolean },
) {
  if (unread)
    return {
      unreadCursorBefore: read.readThrough,
      readPositionAfter: read.modelSeenUpToSeq ?? read.readThrough,
      moreUnread: Boolean(read.hasMore),
    };
  return isHistoryRead ? {} : { unreadCursorBefore: read.readThrough };
}
