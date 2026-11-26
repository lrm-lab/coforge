import type { AgentConsumptionScope } from "@lrm/coforge-sdk/agent";
import type { DirectConversationPorts } from "./agent-targets.repositories.server";

import { resolvedConsumptionScope } from "./resolved-agent-target.server";
import { drainScope } from "./agent-targets.repositories.server";
import {
  AGENT_MESSAGE_WITH_TARGET_INCLUDE,
  messageDeliveryTarget,
  toAgentMessage,
} from "./direct-conversation-agent-message.server";
import { directTargets } from "./agent-peer-direct.repositories.server";
import { isUserAgentDirectConversation } from "#src/features/conversations/direct-key";
import { readChannelCoordinationFromConversations } from "#src/server/conversations/channel-coordination.server";
import { unreadAgentMessagesFragment } from "#src/server/db/repositories/agent-attention.repositories.server";
import { clampPageLimit } from "#src/server/db/page-limit.server";
import {
  advanceAgentReadGroups,
  agentReadGroupsForPage,
  conversationReadChangedPort,
  publishConversationReadChangesAfterCommit,
} from "./agent-read-groups.repositories.server";
import { type AgentRecoveryRow } from "./agent-recovery-row.server";

export async function drainAgentEvents(
  ports: DirectConversationPorts,
  workspaceId: string,
  agentId: string,
  limit = 20,
  target?: string,
): Promise<{
  messages: (ReturnType<typeof toAgentMessage> & {
    consumptionScope: AgentConsumptionScope;
    nonMemberMention?: boolean;
  })[];
  hasMore: boolean;
}> {
  const bounded = clampPageLimit(limit, 100);
  const scope = target ? await drainScope(ports, workspaceId, agentId, target) : undefined;
  const committed = await publishConversationReadChangesAfterCommit(
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
          return { result: { page, hasMore: false }, conversationReadChanges: [] };
        const conversationIds = [...new Set(page.map((row) => row.conversationId))];
        const [conversations, members] = await Promise.all([
          tx.conversation.findMany({
            where: { id: { in: conversationIds } },
            select: {
              id: true,
              channelName: true,
              directKey: true,
              attachmentCommentThread: { select: { conversationId: true } },
            },
          }),
          tx.conversationMember.findMany({
            where: { agentId, conversationId: { in: conversationIds } },
            select: { id: true, conversationId: true },
          }),
        ]);
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
        const memberIdByConversation = new Map(members.map((m) => [m.conversationId, m.id]));
        const missingAttachmentCommentConversationIds = conversations
          .filter((row) => row.attachmentCommentThread && !memberIdByConversation.has(row.id))
          .map((row) => row.id);
        if (missingAttachmentCommentConversationIds.length <= 1) {
          for (const conversationId of missingAttachmentCommentConversationIds) {
            const seat = await tx.conversationMember.upsert({
              where: { conversationId_agentId: { conversationId, agentId } },
              create: { workspaceId, conversationId, agentId },
              update: { leftAt: null },
            });
            memberIdByConversation.set(conversationId, seat.id);
          }
        } else {
          await tx.conversationMember.createMany({
            data: missingAttachmentCommentConversationIds.map((conversationId) => ({
              workspaceId,
              conversationId,
              agentId,
            })),
            skipDuplicates: true,
          });
          await tx.conversationMember.updateMany({
            where: {
              agentId,
              conversationId: { in: missingAttachmentCommentConversationIds },
            },
            data: { leftAt: null },
          });
          const seated = await tx.conversationMember.findMany({
            where: {
              agentId,
              conversationId: { in: missingAttachmentCommentConversationIds },
            },
            select: { id: true, conversationId: true },
          });
          for (const member of seated) memberIdByConversation.set(member.conversationId, member.id);
        }
        const conversationMetaRows = conversations.map((conversation) => ({
          conversationId: conversation.id,
          conversation: {
            channelName: conversation.channelName,
            directKey: conversation.directKey,
          },
        }));
        const changes = await advanceAgentReadGroups({
          db: tx,
          groups: targetGroups.values(),
          memberIdByConversation,
          messageRows: conversationMetaRows,
          isUserAgentDirectConversation,
          workspaceId,
          agentId,
        });
        return { result: { page, hasMore }, conversationReadChanges: changes };
      }),
    conversationReadChangedPort(ports.realtime),
  );
  if (committed.page.length === 0) return { messages: [], hasMore: false };
  const messageRows = await ports.db.message.findMany({
    where: { id: { in: committed.page.map((row) => row.id) } },
    include: AGENT_MESSAGE_WITH_TARGET_INCLUDE,
  });
  if (messageRows.length === 0) return { messages: [], hasMore: committed.hasMore };
  const rowById = new Map(messageRows.map((row) => [row.id, row]));
  const messageConversations = messageRows.map((row) => row.conversation);
  const [targetOf, coordination] = await Promise.all([
    directTargets(ports.db, workspaceId, agentId, messageConversations),
    readChannelCoordinationFromConversations(ports.db, workspaceId, agentId, messageConversations),
  ]);
  const messages = committed.page.flatMap((row) => {
    const message = rowById.get(row.id);
    if (!message) return [];
    return [
      {
        ...toAgentMessage(
          message,
          messageDeliveryTarget(message, targetOf),
          agentId,
          coordination.get(row.conversationId),
        ),
        consumptionScope: resolvedConsumptionScope(row.conversationId, row.threadRootId),
        ...(row.nonMemberMention ? { nonMemberMention: true } : {}),
      },
    ];
  });
  return { messages, hasMore: committed.hasMore };
}
