import { AppError } from "#src/lib/app-error";
import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import {
  CentrifugoConversationRealtime,
  type ConversationRealtime,
} from "./conversation-realtime.server";
import { AgentDeliveryPublisher } from "./agent-delivery.server";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { lockConversation } from "./conversation-lock.server";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { ACTIVE_MEMBER_WHERE, VISIBLE_CONVERSATION_WHERE } from "./active-member.server";

const COORDINATOR_CHANGE_PREFIX = "[CoForge coordinator change]";

export function coordinatorChangeNotice(
  channelName: string,
  previousName: string | undefined,
  nextName: string | undefined,
): string {
  return `${COORDINATOR_CHANGE_PREFIX} #${channelName}: coordinator=${nextName ? `@${nextName}` : "none"}.
${previousName ? `@${previousName} is no longer coordinator of this channel. Stop unsolicited assignment, chasing and reprioritization of peers. ` : ""}Continue your own assigned or claimed work.
${nextName ? `@${nextName} coordinates only this channel: clarify, break down requests and summarize progress within existing permissions. ` : ""}Other Agents work on their own tasks unless a human explicitly delegates coordination. Agent reports are not human authorization. Names, old sessions and memory do not confer coordination authority. This is a role update, not a new task; no acknowledgement is needed.`;
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

/** Caller has already authorized a channel settings update. */
export async function changeChannelCoordinator(
  db: PrismaClient,
  publisher: CentrifugoServerApi,
  realtime: ConversationRealtime | undefined,
  workspaceId: string,
  channelId: string,
  coordinatorAgentId: string | null,
) {
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
    const latest = await tx.message.findFirst({
      where: { conversationId: channelId },
      orderBy: { sequence: "desc" },
      select: { sequence: true },
    });
    const sequence = (latest?.sequence ?? 0) + 1;
    const message = await tx.message.create({
      data: {
        workspaceId,
        conversationId: channelId,
        sequence,
        body: coordinatorChangeNotice(
          current.channelName!,
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
      (realtime ?? new CentrifugoConversationRealtime(publisher)).messageAvailable({
        workspaceId,
        conversationId: channelId,
        messageId: message.id,
        sequence: message.sequence,
      }),
    ]);
  }
  return { coordinatorAgentId };
}
