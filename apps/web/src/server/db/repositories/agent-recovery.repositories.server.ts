import type { DirectConversationPorts } from "./agent-targets.repositories.server";

import {
  TARGET_CONVERSATION_SELECT,
  conversationTarget,
  deliveryTarget,
  AGENT_FORWARD_SELECT,
} from "./direct-conversation-agent-message.server";
import { recoveryRefs, directTargets } from "./agent-peer-direct.repositories.server";
import { Prisma } from "#src/generated/prisma/client";
import { ACTIVE_MEMBER_WHERE } from "#src/server/conversations/active-member.server";
import { MESSAGE_MENTIONS_SELECT } from "#src/server/conversations/mentions.server";
import {
  agentDeliveryView,
  type AgentReadableBody,
} from "#src/server/conversations/agent-message-view.server";
import {
  agentMessageSender,
  MESSAGE_SENDER_SELECT,
} from "#src/server/conversations/sender-display.server";
import {
  NOTIFIED_AGENT_WHERE,
  pendingDeliveryWhere,
  unreadAgentMessagesFragment,
} from "#src/server/db/repositories/agent-attention.repositories.server";
import {
  AGENT_RECOVERY_MESSAGE_LIMIT,
  recoverySecondPass,
  type AgentRecoveryRow,
} from "./agent-recovery-row.server";
import type {
  AgentRecoveryContext,
  PendingAgentDelivery,
} from "./direct-conversation-types.server";

/** An Agent-facing record as this repository builds it: its `body` comes from `agentMessageView`.
 * The port types keep a plain `body: string`, which this is assignable to. */
type AgentFacing<T extends { body: string }> = Omit<T, "body"> & { body: AgentReadableBody };

export async function readPendingAgentDeliveries(
  ports: DirectConversationPorts,
  workspaceId: string,
  agentId: string,
  /** These deliveries, received or not (a tracked mention issued again), and with
   * `orUnreceived` every unreceived one too. Without it, only the unreceived ones. */
  select?: { deliveryIds: readonly string[]; orUnreceived?: boolean },
): Promise<AgentFacing<PendingAgentDelivery>[]> {
  const unreceived = { receivedAt: null } satisfies Prisma.AgentMessageDeliveryWhereInput;
  const chosen = { deliveryId: { in: [...(select?.deliveryIds ?? [])] } };
  const selected = !select
    ? unreceived
    : { AND: [select.orUnreceived ? { OR: [unreceived, chosen] } : chosen] };
  const deliveries = await ports.db.agentMessageDelivery.findMany({
    // Hidden-channel deliveries wait for restore. Left/removed/private-transition channel
    // memberships never replay; DMs and notified non-member channel messages still do.
    where: await pendingDeliveryWhere(ports.db, { workspaceId, agentId }, selected),
    orderBy: [{ createdAt: "asc" }, { deliveryId: "asc" }],
    // Oldest first, so the cap drops the newest backlog: those rows stay `receivedAt: null` and
    // are replayed by the next accepted session or daemon `ready`.
    take: AGENT_RECOVERY_MESSAGE_LIMIT,
    select: {
      deliveryId: true,
      messageId: true,
      conversationId: true,
      conversation: { select: TARGET_CONVERSATION_SELECT },
      sequence: true,
      reason: true,
      message: {
        select: {
          body: true,
          createdAt: true,
          threadRootId: true,
          sender: MESSAGE_SENDER_SELECT,
          mentions: MESSAGE_MENTIONS_SELECT,
          forward: AGENT_FORWARD_SELECT,
          attachments: { select: { id: true }, orderBy: { position: "asc" } },
          pendingMentionActions: { where: NOTIFIED_AGENT_WHERE(agentId), select: { id: true } },
          memoryHint: { select: { id: true, targetAgentId: true, deliveredAt: true } },
        },
      },
    },
  });
  // A notified delivery reaches the Agent as a non-member only while it is not in the channel.
  const memberOf = new Set(
    (
      await ports.db.conversationMember.findMany({
        where: {
          agentId,
          ...ACTIVE_MEMBER_WHERE,
          conversationId: { in: [...new Set(deliveries.map((d) => d.conversationId))] },
        },
        select: { conversationId: true },
      })
    ).map((member) => member.conversationId),
  );
  const targetOf = await directTargets(
    ports.db,
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
      deliveryId: delivery.deliveryId,
      conversationId: delivery.conversationId,
      sequence: delivery.sequence,
      createdAtMs: delivery.message.createdAt.getTime(),
      target,
      latestSenderKind: sender.kind,
      latestSenderHandle: sender.handle,
      latestSenderDescription: sender.description,
      ...agentDeliveryView(delivery.message, agentId),
      // A comment notification's reason rides the envelope on replay exactly as the live push
      // sent it.
      ...(delivery.reason ? { reason: delivery.reason } : {}),
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

export async function readAgentRecoveryContext(
  ports: DirectConversationPorts,
  workspaceId: string,
  agentId: string,
): Promise<
  Omit<AgentRecoveryContext, "resumeMessages"> & {
    resumeMessages: AgentFacing<AgentRecoveryContext["resumeMessages"][number]>[];
  }
> {
  // One statement over every unread message the Agent owes attention to, ranked globally by
  // (conversation, thread root, sequence). Rows past the resume budget are kept only for the
  // first message of each target so unreadSummary stays complete without a second pass.
  const rows = await ports.db.$queryRaw<AgentRecoveryRow[]>`
    WITH unread AS (
      ${unreadAgentMessagesFragment(workspaceId, agentId)}
    ), ranked AS (
      SELECT u.*,
        (COUNT(*) OVER (PARTITION BY "conversationId", "threadRootId"))::int AS "unreadCount",
        (ROW_NUMBER() OVER (PARTITION BY "conversationId", "threadRootId" ORDER BY "sequence"))::int AS "targetRank",
        (ROW_NUMBER() OVER (ORDER BY "conversationId", "rootSequence", "sequence"))::int AS "globalRank"
      FROM unread u
    )
    SELECT "id", "sequence", "body", "conversationId", "threadRootId", "senderMemberId", "createdAt",
      "deliveryId", "senderAgentName", "senderAgentDescription", "senderUsername",
      "senderUserDescription", "channelName", "otherUsername", "agentPeer", "unreadCount", "globalRank",
      "nonMemberMention", "attachmentId"
    FROM ranked
    WHERE "globalRank" <= ${AGENT_RECOVERY_MESSAGE_LIMIT} OR "targetRank" = 1
    ORDER BY "globalRank"`;
  const resumeMessages: AgentFacing<AgentRecoveryContext["resumeMessages"][number]>[] = [];
  const unreadSummary: Record<string, number> = {};
  const unreadConversationIds: Record<string, string> = {};
  const { mentionsByMessage, hintsByMessage, forwardsByMessage } = await recoverySecondPass(
    ports.db,
    workspaceId,
    agentId,
    rows,
  );
  const directRefOf = await recoveryRefs(ports.db, workspaceId, agentId, rows);
  for (const row of rows) {
    if (!row.channelName && !row.otherUsername && !row.attachmentId)
      throw new Error("Agent conversation has no other member to target");
    // A comment notification names its file (`attachment:<id>`), a reply its comment thread.
    const target = deliveryTarget(
      row.attachmentId
        ? `attachment:${row.attachmentId}`
        : row.channelName
          ? `#${row.channelName}`
          : directRefOf(row),
      row.threadRootId,
    );
    unreadSummary[target] ??= row.unreadCount;
    unreadConversationIds[target] = row.conversationId;
    if (row.globalRank > AGENT_RECOVERY_MESSAGE_LIMIT) continue;
    if (!row.deliveryId) throw new Error(`Unread Agent message has no delivery: ${row.id}`);
    // Read the author from the message with the shared sender projection. A DM peer is the
    // recipient, so deriving the author from the conversation misattributes Agent messages.
    const sender = agentMessageSender(
      row.senderMemberId === null
        ? null
        : {
            agentId: row.senderAgentName !== null ? row.senderMemberId : null,
            agent:
              row.senderAgentName !== null
                ? { name: row.senderAgentName, description: row.senderAgentDescription ?? "" }
                : null,
            user:
              row.senderUsername !== null
                ? { username: row.senderUsername, description: row.senderUserDescription ?? "" }
                : null,
          },
    );
    resumeMessages.push({
      messageId: row.id,
      deliveryId: row.deliveryId,
      conversationId: row.conversationId,
      sequence: row.sequence,
      createdAtMs: row.createdAt.getTime(),
      target,
      latestSenderKind: sender.kind,
      latestSenderHandle: sender.handle,
      latestSenderDescription: sender.description,
      ...agentDeliveryView(
        {
          body: row.body,
          mentions: mentionsByMessage.get(row.id) ?? [],
          forward: forwardsByMessage.get(row.id),
          attachments: forwardsByMessage.get(row.id)?.message.attachments,
        },
        agentId,
      ),
      ...(row.nonMemberMention ? { nonMemberMention: true } : {}),
      ...(hintsByMessage.has(row.id)
        ? {
            memoryHint: {
              hint_id: hintsByMessage.get(row.id)!,
              tool: "memory_disposition" as const,
            },
          }
        : {}),
    });
  }
  return {
    resumeMessages,
    unreadSummary,
    ...(Object.keys(unreadConversationIds).length ? { unreadConversationIds } : {}),
  };
}
