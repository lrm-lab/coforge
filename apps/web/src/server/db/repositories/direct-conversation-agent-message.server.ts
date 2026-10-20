import type { Prisma } from "#src/generated/prisma/client";
import type { MessageTaskMetadata, TaskStatus } from "@lrm/coforge-sdk/internal";
import type { AttachmentMetadata } from "./direct-conversation.repositories.server";
import { humanLabel, type HumanNames } from "#src/lib/human-label";
import {
  agentMessageSender,
  MESSAGE_SENDER_SELECT,
} from "#src/server/conversations/sender-display.server";
import { agentMessageView } from "#src/server/conversations/agent-message-view.server";
import {
  MESSAGE_MENTIONS_SELECT,
  type MessageMentionRef,
} from "#src/server/conversations/mentions.server";
import { channelTarget } from "#src/server/conversations/agent-delivery.server";

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

/** Message projection sent to an Agent. */
export const AGENT_MESSAGE_INCLUDE = {
  memoryHint: { select: { id: true, targetAgentId: true, deliveredAt: true } },
  sender: MESSAGE_SENDER_SELECT,
  attachments: { orderBy: { position: "asc" } },
  task: TASK_METADATA_SELECT,
  actionCard: ACTION_CARD_STATE_SELECT,
  mentions: MESSAGE_MENTIONS_SELECT,
} satisfies Prisma.MessageInclude;

export type DirectConversationMessageRow = Prisma.MessageGetPayload<{
  include: typeof AGENT_MESSAGE_INCLUDE;
}>;

/** A delivery target is the conversation target, suffixed with the thread root when replying. */
export function deliveryTarget(parent: string, rootId?: string | null) {
  if (!rootId) return parent;
  return `${parent}:${rootId}`;
}

/** `#channel` for a public channel, otherwise `@username` of the conversation's user member. */
export function conversationTarget(conversation: {
  channelName: string | null;
  members: { user: { username: string } | null }[];
}) {
  return conversation.channelName
    ? channelTarget(conversation.channelName)
    : `@${conversation.members[0]?.user?.username}`;
}

/** The one member `conversationTarget` names a direct conversation by: its user member. */
export const CONVERSATION_TARGET_MEMBERS = {
  where: { userId: { not: null } },
  select: { user: { select: { username: true } } },
  take: 1,
} satisfies Prisma.Conversation$membersArgs;

/** `AGENT_MESSAGE_INCLUDE` plus what `messageDeliveryTarget` reads from the conversation. */
export const AGENT_MESSAGE_WITH_TARGET_INCLUDE = {
  ...AGENT_MESSAGE_INCLUDE,
  conversation: { include: { members: CONVERSATION_TARGET_MEMBERS } },
} satisfies Prisma.MessageInclude;

/** Where a Message is delivered: its conversation's target, with its thread root if it has one. */
export function messageDeliveryTarget(message: {
  threadRootId: string | null;
  conversation: Parameters<typeof conversationTarget>[0];
}) {
  return deliveryTarget(conversationTarget(message.conversation), message.threadRootId);
}

export function toAgentMessage(
  row: Pick<DirectConversationMessageRow, "id" | "sequence" | "body" | "createdAt"> & {
    sender: Parameters<typeof agentMessageSender>[0];
    task: Parameters<typeof messageTask>[0];
    attachments: AttachmentMetadata[];
    actionCard?: { state: string } | null;
    memoryHint?: { id: string; targetAgentId: string; deliveredAt: Date | null } | null;
    mentions?: MessageMentionRef[];
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
      { body: row.body, mentions: row.mentions ?? [], actionCard: row.actionCard },
      readerAgentId,
      channelCoordination,
    ),
    createdAt: row.createdAt,
    target,
    attachments: row.attachments,
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
