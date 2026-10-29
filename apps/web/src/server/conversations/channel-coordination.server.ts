import { AppError } from "#src/lib/app-error";
import { humanLabel } from "#src/lib/human-label";
import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import {
  CentrifugoConversationRealtime,
  type ConversationRealtime,
} from "./conversation-realtime.server";
import { AgentDeliveryPublisher } from "./agent-delivery.server";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { lockConversation } from "./conversation-lock.server";
import { allocateSequence } from "#src/server/db/repositories/sequence-allocation.server";
import { resolveChannelAuthority } from "./channel-authority.server";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { ACTIVE_MEMBER_WHERE, VISIBLE_CONVERSATION_WHERE } from "./active-member.server";
import { announceMessage } from "./conversation-activity.server";

/**
 * One sentence, like the Task notices: who changed the coordinator, to whom. What a coordinator
 * may and may not do lives in every Agent's standing instructions, not here.
 */
export function coordinatorChangeNotice(
  channelName: string,
  actorName: string,
  previousName: string | undefined,
  nextName: string | undefined,
): string {
  if (!nextName) return `${actorName} removed @${previousName} as coordinator of #${channelName}`;
  return `${actorName} made @${nextName} the coordinator of #${channelName}${previousName ? ` (replacing @${previousName})` : ""}`;
}

/** Current settings once per read window, including revocations made before role notices existed. */
export async function readChannelCoordination(
  db: Pick<Prisma.TransactionClient, "conversation">,
  workspaceId: string,
  readerAgentId: string,
  conversationIds: readonly string[],
): Promise<Map<string, string>> {
  if (!conversationIds.length) return new Map();
  const ids = [...new Set(conversationIds)];
  const channels = await db.conversation.findMany({
    where: {
      workspaceId,
      id: { in: ids },
      channelName: { not: null },
      ...VISIBLE_CONVERSATION_WHERE,
    },
    select: {
      id: true,
      coordinatorAgent: {
        select: {
          id: true,
          name: true,
          deletedAt: true,
          conversations: {
            where: { conversationId: { in: ids }, ...ACTIVE_MEMBER_WHERE },
            select: { conversationId: true },
          },
        },
      },
    },
  });
  return new Map(
    channels.map((channel) => {
      const candidate = channel.coordinatorAgent;
      const coordinator =
        candidate &&
        !candidate.deletedAt &&
        candidate.conversations.some((member) => member.conversationId === channel.id)
          ? candidate
          : null;
      const role = coordinator?.id === readerAgentId ? "coordinator" : "member";
      return [
        channel.id,
        `[CoForge current channel role: ${role}; coordinator=${coordinator ? `@${coordinator.name}` : "none"}]`,
      ];
    }),
  );
}

/** A channel settings update: only a user who may update the channel changes its coordinator. */
export async function changeChannelCoordinator(
  db: PrismaClient,
  publisher: CentrifugoServerApi,
  realtime: ConversationRealtime | undefined,
  workspaceId: string,
  userId: string,
  channel: { id: string; channelName: string | null },
  coordinatorAgentId: string | null,
) {
  const authority = await resolveChannelAuthority(db, workspaceId, { userId }, channel);
  if (!authority.capabilities.update) throw new AppError("ACCESS_DENIED");
  const channelId = channel.id;
  const change = await db.$transaction(async (tx) => {
    await lockConversation(tx, channelId);
    const current = await tx.conversation.findUniqueOrThrow({
      where: { id: channelId },
      select: {
        coordinatorAgentId: true,
        channelName: true,
        coordinatorAgent: { select: { name: true } },
      },
    });
    const members = await tx.conversationMember.findMany({
      where: {
        conversationId: channelId,
        agentId: {
          in: [current.coordinatorAgentId, coordinatorAgentId].filter(
            (id): id is string => id !== null,
          ),
        },
        ...ACTIVE_MEMBER_WHERE,
        agent: { ...ACTIVE_AGENT_WHERE, workspaceId },
      },
      select: { agent: { select: { id: true, name: true, computerId: true, stoppedAt: true } } },
    });
    const next = members.find((member) => member.agent?.id === coordinatorAgentId)?.agent;
    if (coordinatorAgentId && !next) throw new AppError("NOT_FOUND");
    if (current.coordinatorAgentId === coordinatorAgentId) return;
    await tx.conversation.update({
      where: { id: channelId },
      data: { coordinatorAgentId },
    });
    const sequence = await allocateSequence(tx, channelId);
    const actor = await tx.user.findUniqueOrThrow({
      where: { id: userId },
      select: { displayName: true, username: true },
    });
    const message = await tx.message.create({
      data: {
        workspaceId,
        conversationId: channelId,
        sequence,
        body: coordinatorChangeNotice(
          current.channelName!,
          humanLabel(actor),
          current.coordinatorAgent?.name,
          next?.name,
        ),
        deliveries: {
          create: members.flatMap(({ agent }) =>
            agent ? [{ workspaceId, conversationId: channelId, agentId: agent.id, sequence }] : [],
          ),
        },
      },
      include: { deliveries: true },
    });
    return { message, members, target: `#${current.channelName}` };
  });
  if (change) {
    const { message, members, target } = change;
    await Promise.allSettled([
      new AgentDeliveryPublisher(publisher).publish(
        workspaceId,
        message.deliveries.map((delivery) => {
          const agent = members.find((member) => member.agent?.id === delivery.agentId)?.agent;
          return {
            computerId: agent?.stoppedAt ? null : (agent?.computerId ?? null),
            requestId: message.id,
            conversationId: channelId,
            agentId: delivery.agentId,
            messageId: message.id,
            deliveryId: delivery.deliveryId,
            sequence: message.sequence,
            createdAtMs: message.createdAt.getTime(),
            body: message.body,
            mentions: [],
            target,
            latestSenderKind: "system" as const,
            latestSenderHandle: "",
            latestSenderDescription: "",
          };
        }),
      ),
      announceMessage(db, realtime ?? new CentrifugoConversationRealtime(publisher), {
        workspaceId,
        conversationId: channelId,
        messageId: message.id,
        sequence: message.sequence,
      }),
    ]);
  }
  return { coordinatorAgentId };
}
