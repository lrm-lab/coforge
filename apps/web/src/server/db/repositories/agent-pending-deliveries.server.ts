import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import {
  CONVERSATION_TARGET_MEMBERS,
  conversationTarget,
  deliveryTarget,
} from "./direct-conversation-agent-message.server";
import { directTargets } from "./agent-peer-direct.repositories.server";
import { pendingDeliveryWhere, NOTIFIED_AGENT_WHERE } from "./agent-attention.repositories.server";
import { ACTIVE_MEMBER_WHERE } from "#src/server/conversations/active-member.server";
import { readChannelCoordination } from "#src/server/conversations/channel-coordination.server";
import {
  agentMessageSender,
  MESSAGE_SENDER_SELECT,
} from "#src/server/conversations/sender-display.server";
import { MESSAGE_MENTIONS_SELECT } from "#src/server/conversations/mentions.server";
import { agentMessageView } from "#src/server/conversations/agent-message-view.server";
import { readTaskExecutionSignal } from "@lrm/coforge-sdk/internal";

/** Canonical pending deliveries, including immutable task controls, for daemon replay. */
export async function readPendingAgentDeliveries(
  db: PrismaClient,
  workspaceId: string,
  agentId: string,
  select?: { deliveryIds: readonly string[]; orUnreceived?: boolean },
) {
  const unreceived = { receivedAt: null } satisfies Prisma.AgentMessageDeliveryWhereInput;
  const chosen = { deliveryId: { in: [...(select?.deliveryIds ?? [])] } };
  const selected = !select
    ? unreceived
    : { AND: [select.orUnreceived ? { OR: [unreceived, chosen] } : chosen] };
  const deliveries = await db.agentMessageDelivery.findMany({
    // Hidden-channel deliveries wait for restore. Left/removed/private-transition channel
    // memberships never replay; DMs and notified non-member channel messages still do.
    where: await pendingDeliveryWhere(db, { workspaceId, agentId }, selected),
    orderBy: [{ createdAt: "asc" }, { deliveryId: "asc" }],
    select: {
      deliveryId: true,
      taskExecutionSignal: true,
      messageId: true,
      conversationId: true,
      conversation: {
        select: { channelName: true, directKey: true, members: CONVERSATION_TARGET_MEMBERS },
      },
      sequence: true,
      message: {
        select: {
          body: true,
          createdAt: true,
          threadRootId: true,
          sender: MESSAGE_SENDER_SELECT,
          mentions: MESSAGE_MENTIONS_SELECT,
          pendingMentionActions: { where: NOTIFIED_AGENT_WHERE(agentId), select: { id: true } },
          memoryHint: { select: { id: true, targetAgentId: true, deliveredAt: true } },
        },
      },
    },
  });
  // A notified delivery reaches the Agent as a non-member only while it is not in the channel.
  const memberOf = new Set(
    (
      await db.conversationMember.findMany({
        where: {
          agentId,
          ...ACTIVE_MEMBER_WHERE,
          conversationId: { in: [...new Set(deliveries.map((d) => d.conversationId))] },
        },
        select: { conversationId: true },
      })
    ).map((member) => member.conversationId),
  );
  const coordination = await readChannelCoordination(
    db,
    workspaceId,
    agentId,
    deliveries
      .filter((delivery) => delivery.conversation.channelName !== null)
      .map((delivery) => delivery.conversationId),
  );
  const targetOf = await directTargets(
    db,
    workspaceId,
    agentId,
    deliveries.map((delivery) => delivery.conversation),
  );
  return deliveries.map((delivery) => {
    // agentMessageSender handles both human and Agent authors and validates the handle;
    // reading sender.user alone produces a bare @ for Agent messages.
    const sender = agentMessageSender(delivery.message.sender);
    const target = deliveryTarget(
      conversationTarget(delivery.conversation, targetOf),
      delivery.message.threadRootId,
    );
    return {
      messageId: delivery.messageId,
      ...(delivery.taskExecutionSignal
        ? { taskExecutionSignal: readTaskExecutionSignal(delivery.taskExecutionSignal) }
        : {}),
      deliveryId: delivery.deliveryId,
      conversationId: delivery.conversationId,
      sequence: delivery.sequence,
      createdAtMs: delivery.message.createdAt.getTime(),
      target,
      latestSenderKind: sender.kind,
      latestSenderHandle: sender.handle,
      latestSenderDescription: sender.description,
      ...agentMessageView(delivery.message, agentId, coordination.get(delivery.conversationId)),
      ...(delivery.message.memoryHint?.deliveredAt &&
      delivery.message.memoryHint.targetAgentId === agentId
        ? {
            memoryHint: {
              hint_id: delivery.message.memoryHint.id,
              tool: "memory_disposition" as const,
            },
          }
        : {}),
      ...(delivery.message.pendingMentionActions.length && !memberOf.has(delivery.conversationId)
        ? { nonMemberMention: true }
        : {}),
    };
  });
}
