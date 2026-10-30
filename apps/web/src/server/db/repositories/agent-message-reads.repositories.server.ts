import type { DirectConversationPorts } from "./agent-targets.repositories.server";

import { resolveMessage } from "./agent-targets.repositories.server";
import { readDirectConversationMessagesPage } from "./agent-message-history-adapter.server";
import { advanceThreadRead } from "./thread-read-position.server";
import { recordReadAdvance } from "#src/server/conversations/human-unread.server";
import {
  MESSAGE_MENTIONS_SELECT,
  type MessageMentionRef,
} from "#src/server/conversations/mentions.server";
import {
  agentMessageView,
  type StoredAgentForward,
} from "#src/server/conversations/agent-message-view.server";
import { AGENT_FORWARD_SELECT } from "./direct-conversation-agent-message.server";
import { pendingMentionActionsForMessage } from "#src/server/conversations/pending-mention-views.server";
import { unresolvedMentionHandles } from "#src/server/conversations/unresolved-mentions.server";
import {
  agentMessageSender,
  MESSAGE_SENDER_SELECT,
} from "#src/server/conversations/sender-display.server";
import { readChannelCoordination } from "#src/server/conversations/channel-coordination.server";
import type { ResolvedAgentTarget } from "./resolved-agent-target.server";
import { conversationReadChangedPort } from "./agent-read-groups.repositories.server";
import type {
  AgentMentionReport,
  DirectConversationPageOptions,
} from "./direct-conversation-types.server";

export async function readMessagesPage(
  ports: DirectConversationPorts,
  workspaceId: string,
  agentId: string,
  target: string,
  page: DirectConversationPageOptions = {},
) {
  return readDirectConversationMessagesPage({
    db: ports.db,
    workspaceId,
    agentId,
    target,
    page,
    resolveTarget: (value) => ports.resolveAgentTarget(workspaceId, agentId, value),
    resolveAnchor: (conversationId, anchor) => resolveMessage(ports, conversationId, anchor),
    conversationReadChanged: conversationReadChangedPort(ports.realtime),
  });
}

export async function advanceAgentReadThrough(
  ports: DirectConversationPorts,
  workspaceId: string,
  agentId: string,
  target: string,
  seenUpToSequence: number,
): Promise<number> {
  return advanceResolvedAgentReadThrough(
    ports,
    workspaceId,
    agentId,
    await ports.resolveAgentTarget(workspaceId, agentId, target),
    seenUpToSequence,
  );
}

export async function advanceResolvedAgentReadThrough(
  ports: DirectConversationPorts,
  workspaceId: string,
  agentId: string,
  { conversationId, threadRootId }: ResolvedAgentTarget,
  seenUpToSequence: number,
): Promise<number> {
  const latest = await ports.db.message.findFirst({
    where: { conversationId, threadRootId },
    orderBy: { sequence: "desc" },
    select: { sequence: true },
  });
  const bounded = Math.min(seenUpToSequence, latest?.sequence ?? 0);
  if (bounded && threadRootId) {
    const member = await ports.db.conversationMember.findUniqueOrThrow({
      where: { conversationId_agentId: { conversationId, agentId } },
      select: { id: true },
    });
    await advanceThreadRead(
      ports.db,
      member.id,
      conversationId,
      workspaceId,
      threadRootId,
      bounded,
    );
  } else if (bounded)
    await ports.db.$transaction(async (tx) => {
      const advanced = await tx.conversationMember.updateMany({
        where: {
          conversationId,
          workspaceId,
          agentId,
          agentReadThroughSequence: { lt: bounded },
        },
        data: { agentReadThroughSequence: bounded },
      });
      // The other side of a direct message reads when the Agent's cursor moves; a channel keeps no
      // such record.
      if (advanced.count > 0) {
        const member = await tx.conversationMember.findFirstOrThrow({
          where: { conversationId, workspaceId, agentId },
          select: { id: true },
        });
        await recordReadAdvance(tx, {
          conversationId,
          memberId: member.id,
          sequence: bounded,
        });
      }
    });
  return bounded;
}

/** These messages, oldest first, as Agent-facing records. */
export async function agentMessagesByIds(
  ports: DirectConversationPorts,
  ids: readonly { id: string }[],
  canonicalTarget: string,
  reader: { workspaceId: string; agentId: string },
) {
  if (!ids.length) return [];
  const rows = await ports.db.message.findMany({
    where: { id: { in: ids.map((row) => row.id) } },
    orderBy: { sequence: "asc" },
    include: {
      sender: MESSAGE_SENDER_SELECT,
      attachments: { orderBy: { position: "asc" } },
      mentions: MESSAGE_MENTIONS_SELECT,
      forward: AGENT_FORWARD_SELECT,
    },
  });
  const coordination = await readChannelCoordination(
    ports.db,
    reader.workspaceId,
    reader.agentId,
    canonicalTarget.startsWith("#") ? rows.map((row) => row.conversationId) : [],
  );
  return rows.map((m) =>
    agentContextRecord(m, canonicalTarget, coordination.get(m.conversationId)),
  );
}

/** One row of the Agent-facing context window, shared by the pending and recent readers so both
 * surfaces cannot drift apart. */
function agentContextRecord<
  Row extends {
    id: string;
    sequence: number;
    sender: Parameters<typeof agentMessageSender>[0];
    body: string;
    mentions: readonly MessageMentionRef[];
    forward?: StoredAgentForward | null;
    createdAt: Date;
    attachments: { id: string; fileName: string; contentType: string; sizeBytes: number }[];
  },
>(m: Row, canonicalTarget: string, channelCoordination?: string) {
  const sender = agentMessageSender(m.sender);
  return {
    id: m.id,
    sequence: m.sequence,
    senderKind: sender.kind,
    senderHandle: sender.handle,
    senderDescription: sender.description,
    ...agentMessageView(m, undefined, channelCoordination),
    createdAt: m.createdAt,
    target: canonicalTarget,
    attachments: m.attachments,
  };
}

/**
 * What an Agent's channel message did not reach: its pending mention actions (people and public
 * Agents outside the channel) and the `@handle`s that name nobody the Agent can see. Read from
 * the stored message, so an idempotent replay reports what the first send did. Empty for a DM.
 */
export async function agentMentionReport(
  ports: DirectConversationPorts,
  workspaceId: string,
  agentId: string,
  message: { id: string; conversationId: string; body: string },
): Promise<AgentMentionReport> {
  const conversation = await ports.db.conversation.findFirst({
    where: { id: message.conversationId, workspaceId, channelName: { not: null } },
    select: {
      channelName: true,
      archivedAt: true,
      members: { where: { agentId }, select: { id: true } },
    },
  });
  const senderMemberId = conversation?.members[0]?.id;
  if (!conversation || !senderMemberId)
    return { pendingMentionActions: [], unresolvedMentionHandles: [] };
  const [pendingMentionActions, unresolved] = await Promise.all([
    pendingMentionActionsForMessage(
      ports.db,
      { ...message, workspaceId, senderMemberId },
      { archived: conversation.archivedAt !== null, name: conversation.channelName! },
    ),
    unresolvedMentionHandles(ports.db, workspaceId, { agentId }, message.body),
  ]);
  return { pendingMentionActions, unresolvedMentionHandles: unresolved };
}

/** `agentMentionReport` for a message this Agent already committed, found by its id. Only the
 * Agent that sent the message reads its report. */
export async function committedAgentMentionReport(
  ports: DirectConversationPorts,
  workspaceId: string,
  agentId: string,
  messageId: string,
): Promise<AgentMentionReport> {
  const message = await ports.db.message.findFirst({
    where: { id: messageId, workspaceId, sender: { agentId } },
    select: { id: true, conversationId: true, body: true },
  });
  return message
    ? agentMentionReport(ports, workspaceId, agentId, message)
    : { pendingMentionActions: [], unresolvedMentionHandles: [] };
}
