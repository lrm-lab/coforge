import type { DirectConversationPorts } from "./agent-targets.repositories.server";

import { drainScope } from "./agent-targets.repositories.server";
import {
  AGENT_MESSAGE_WITH_TARGET_INCLUDE,
  messageDeliveryTarget,
  toAgentMessage,
} from "./direct-conversation-agent-message.server";
import { directTargets } from "./agent-peer-direct.repositories.server";
import { isUserAgentDirectConversation } from "#src/features/conversations/direct-key";
import { readChannelCoordination } from "#src/server/conversations/channel-coordination.server";
import { unreadAgentMessagesFragment } from "#src/server/db/repositories/agent-attention.repositories.server";
import { clampPageLimit } from "#src/server/db/page-limit.server";
import {
  advanceAgentReadGroups,
  agentReadGroupsForPage,
  conversationReadChangedPort,
  publishConversationReadChangesAfterCommit,
} from "./agent-read-groups.repositories.server";
import { type AgentRecoveryRow } from "./agent-recovery-row.server";

/**
 * Drain owed attention in (conversation, thread root, sequence) order and advance only
 * returned targets, monotonically. Default 20, capped 100, to bound unscoped transcript input.
 */
export async function drainAgentEvents(
  ports: DirectConversationPorts,
  workspaceId: string,
  agentId: string,
  limit = 20,
  target?: string,
): Promise<{
  messages: (ReturnType<typeof toAgentMessage> & { nonMemberMention?: boolean })[];
  hasMore: boolean;
}> {
  const bounded = clampPageLimit(limit, 100);
  const scope = target ? await drainScope(ports, workspaceId, agentId, target) : undefined;
  return publishConversationReadChangesAfterCommit(
    () =>
      ports.db.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<
          Array<
            Pick<
              AgentRecoveryRow,
              "id" | "conversationId" | "threadRootId" | "sequence" | "nonMemberMention"
            >
          >
        >`
      WITH unread AS (
        ${unreadAgentMessagesFragment(workspaceId, agentId, scope)}
      )
      SELECT "id", "conversationId", "threadRootId", "sequence", "nonMemberMention"
      FROM unread
      ORDER BY "conversationId", "rootSequence", "sequence"
      LIMIT ${bounded + 1}`;
        const hasMore = rows.length > bounded;
        const page = rows.slice(0, bounded);
        if (page.length === 0)
          return { result: { messages: [], hasMore: false }, conversationReadChanges: [] };
        const messageRows = await tx.message.findMany({
          where: { id: { in: page.map((row) => row.id) } },
          include: AGENT_MESSAGE_WITH_TARGET_INCLUDE,
        });
        const rowById = new Map(messageRows.map((row) => [row.id, row]));
        const targetOf = await directTargets(
          tx,
          workspaceId,
          agentId,
          messageRows.map((row) => row.conversation),
        );
        const coordination = await readChannelCoordination(
          tx,
          workspaceId,
          agentId,
          messageRows
            .filter((row) => row.conversation.channelName !== null)
            .map((row) => row.conversationId),
        );
        const messages = page.map((row) => {
          const message = rowById.get(row.id);
          if (!message) throw new Error(`drained Agent message is missing: ${row.id}`);
          return {
            ...toAgentMessage(
              message,
              messageDeliveryTarget(message, targetOf),
              agentId,
              coordination.get(row.conversationId),
            ),
            // Reached the Agent outside the channel: readable, but it cannot reply there.
            ...(row.nonMemberMention ? { nonMemberMention: true } : {}),
          };
        });
        // A notified non-member has no read boundary in the channel: the message is read once.
        const nonMemberIds = page.filter((row) => row.nonMemberMention).map((row) => row.id);
        if (nonMemberIds.length)
          await tx.pendingMentionAction.updateMany({
            where: {
              workspaceId,
              targetAgentId: agentId,
              messageId: { in: nonMemberIds },
              notifiedAt: { not: null },
              targetReadAt: null,
            },
            data: { targetReadAt: new Date() },
          });
        const targetGroups = agentReadGroupsForPage(page);
        const members = await tx.conversationMember.findMany({
          where: {
            agentId,
            conversationId: { in: [...new Set(page.map((r) => r.conversationId))] },
          },
          select: { id: true, conversationId: true },
        });
        const memberIdByConversation = new Map(members.map((m) => [m.conversationId, m.id]));
        const changes = await advanceAgentReadGroups({
          db: tx,
          groups: targetGroups.values(),
          memberIdByConversation,
          messageRows,
          isUserAgentDirectConversation,
          workspaceId,
          agentId,
        });
        return { result: { messages, hasMore }, conversationReadChanges: changes };
      }),
    conversationReadChangedPort(ports.realtime),
  );
}
