import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { ACTIVE_MEMBER_WHERE } from "./active-member.server";
import { channelAgentRecipients } from "./channel-agent-recipients.server";
import { agentDeliveryBlockers, type AgentDeliveryBlocker } from "./agent-delivery-reasons.server";
import { AGENT_THREAD_UNFOLLOWED_SYSTEM_MESSAGE_KIND } from "./channel-threads.server";
import { ConversationHistory } from "./conversation-history.server";

export type MessageSeenByInput = {
  workspaceId: string;
  userId: string;
  conversationId: string;
  messageId: string;
};

export type MessageSeenBy = { kind: "user" | "agent"; id: string };

export type MessageUndeliveredAgent = AgentDeliveryBlocker;

/** Readers and delivery blockers for one of the viewer's own messages, excluding the sender. */
export async function readMessageSeenBy(
  db: PrismaClient,
  input: MessageSeenByInput,
): Promise<{
  seen: MessageSeenBy[];
  seenAt?: string;
  undeliveredAgents: MessageUndeliveredAgent[];
}> {
  const authorization = await new ConversationHistory(db).authorize(
    input.workspaceId,
    input.userId,
    input.conversationId,
  );
  if (!authorization.activeMemberId) throw new AppError("ACCESS_DENIED");

  const message = await db.message.findFirst({
    where: {
      id: input.messageId,
      conversationId: input.conversationId,
      workspaceId: input.workspaceId,
    },
    select: {
      senderMemberId: true,
      sequence: true,
      createdAt: true,
      threadRootId: true,
      conversation: { select: { channelName: true, directKey: true, coordinatorAgentId: true } },
      mentions: { select: { kind: true, actorId: true } },
    },
  });
  if (!message || message.senderMemberId !== authorization.activeMemberId)
    throw new AppError("NOT_FOUND");

  const [members, firstRead] = await Promise.all([
    db.conversationMember.findMany({
      where: {
        conversationId: input.conversationId,
        workspaceId: input.workspaceId,
        ...ACTIVE_MEMBER_WHERE,
        id: { not: authorization.activeMemberId },
        // A person counts only if they were in the conversation when the message was sent (task
        // #549): joining or being added starts a person's read cursor at the conversation's end, so
        // a cursor past the message says nothing about whether someone who came later saw it. An
        // Agent's cursor moves only when it reads (`message read`, a delivery's drain), so an Agent
        // seated after the message that read it has seen it.
        OR: [{ agentId: { not: null } }, { joinedAt: { lte: message.createdAt } }],
      },
      select: {
        id: true,
        userId: true,
        agentId: true,
        notificationLevel: true,
        readThroughSequence: true,
        agentReadThroughSequence: true,
      },
    }),
    // When the other side first read it, for a direct conversation only: a channel keeps no such
    // record, and the caller shows no time rather than a guess.
    db.messageRead.findFirst({
      where: {
        conversationId: input.conversationId,
        workspaceId: input.workspaceId,
        memberId: { not: authorization.activeMemberId },
        sequence: { gte: message.sequence },
      },
      orderBy: { readAt: "asc" },
      select: { readAt: true, conversation: { select: { directKey: true } } },
    }),
  ]);

  const threadReads = message.threadRootId
    ? await db.threadRead.findMany({
        where: {
          conversationId: input.conversationId,
          workspaceId: input.workspaceId,
          rootMessageId: message.threadRootId,
          memberId: { in: members.map((member) => member.id) },
        },
        select: { memberId: true, readThroughSequence: true },
      })
    : [];

  const seenAt =
    firstRead?.conversation.directKey === null || !firstRead
      ? undefined
      : firstRead.readAt.toISOString();

  const threadReadThrough = new Map(
    threadReads.map((read) => [read.memberId, read.readThroughSequence]),
  );
  const seen = members.flatMap((member) => {
    const id = member.agentId ?? member.userId;
    const readThrough = message.threadRootId
      ? (threadReadThrough.get(member.id) ?? 0)
      : member.agentId
        ? member.agentReadThroughSequence
        : member.readThroughSequence;
    return id && readThrough >= message.sequence
      ? [{ kind: member.agentId ? ("agent" as const) : ("user" as const), id }]
      : [];
  });

  if (message.conversation.channelName === null)
    return { ...(seenAt ? { seenAt } : {}), seen, undeliveredAgents: [] };

  const [audience, unfollowNotices] = await Promise.all([
    channelAgentRecipients(db, {
      conversationId: input.conversationId,
      threadRootId: message.threadRootId ?? undefined,
      mentions: message.mentions.map((mention) => ({ type: mention.kind, id: mention.actorId })),
    }),
    message.threadRootId
      ? db.$queryRaw<{ agentId: string; rootMessageId: string }[]>(Prisma.sql`
          -- system_messages has @@index([conversationId, workspaceId]); both equality predicates
          -- keep this historical structured-notice lookup scoped before kind/JSON filtering.
          SELECT DISTINCT sm."params"->>'agentId' AS "agentId",
            sm."params"->>'rootMessageId' AS "rootMessageId"
          FROM "system_messages" sm
          JOIN "messages" m ON m."id" = sm."messageId" AND m."conversationId" = sm."conversationId"
          WHERE sm."workspaceId" = ${input.workspaceId}::uuid
            AND sm."conversationId" = ${input.conversationId}::uuid
            AND sm."kind" = ${AGENT_THREAD_UNFOLLOWED_SYSTEM_MESSAGE_KIND}
            AND m."sequence" < ${message.sequence}
            AND sm."params"->>'rootMessageId' = ${message.threadRootId}
            AND sm."params"->>'agentId' IS NOT NULL
        `)
      : Promise.resolve([]),
  ]);
  const undeliveredAgents = agentDeliveryBlockers({
    // ConversationMember has no mute-transition timestamp. `channel_muted` therefore describes
    // the current-state audience approximation; a mute changed after send cannot be distinguished.
    message: {
      threadRootId: message.threadRootId,
      hasAgentMention: message.mentions.some((mention) => mention.kind === "agent"),
    },
    agents: members.flatMap((member) =>
      member.agentId
        ? [{ agentId: member.agentId, notificationLevel: member.notificationLevel }]
        : [],
    ),
    audience: new Set(audience),
    seenAgentIds: seen.flatMap((reader) => (reader.kind === "agent" ? [reader.id] : [])),
    hasActiveCoordinator: Boolean(
      message.conversation.coordinatorAgentId &&
      members.some((member) => member.agentId === message.conversation.coordinatorAgentId),
    ),
    unfollowed: unfollowNotices,
  });

  return {
    ...(seenAt ? { seenAt } : {}),
    seen,
    undeliveredAgents,
  };
}
