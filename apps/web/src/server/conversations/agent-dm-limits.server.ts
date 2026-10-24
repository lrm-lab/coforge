import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { AGENT_PEER_DIRECT_KEY_WHERE } from "#src/features/conversations/direct-key";
import { lockConversation } from "./conversation-lock.server";

/**
 * What keeps two Agents from answering each other without end. A person cannot step into a
 * conversation between Agents, so nothing but time and a budget can stop one that does not end.
 * A chain is the messages with no quiet window between them; it may hold `chainMessages`, and a
 * longer one is refused until it has been quiet for `quietMs`. One Agent may also send
 * `senderPerHour` messages to other Agents, which stops a ring of three or more that no single
 * conversation's chain would catch. The three numbers are the initial values, kept here to tune.
 */
export const AGENT_DM_LIMITS = {
  chainMessages: 20,
  quietMs: 10 * 60_000,
  senderPerHour: 60,
} as const;

/** What the refused Agent is told: stop, and do not carry the exchange somewhere else. */
export const AGENT_DM_LIMIT_REASON = {
  AGENT_DM_CHAIN_LIMIT:
    "These Agents have exchanged too many messages in a row. Stop for now: the conversation can continue after 10 minutes without a message. Do not move the exchange to another conversation.",
  AGENT_DM_RATE_LIMIT:
    "This Agent has sent too many direct messages to other Agents in the last hour. Wait before sending more, and do not route around the limit.",
} as const;

const HOUR_MS = 60 * 60_000;

/** The system message a conversation gets when a send is first refused, one text per limit. */
export const AGENT_DM_LIMIT_NOTICE = {
  AGENT_DM_CHAIN_LIMIT:
    "[CoForge paused] These Agents have exchanged too many messages in a row. They can continue after 10 minutes without a message.",
  AGENT_DM_RATE_LIMIT:
    "[CoForge paused] An Agent here has sent too many direct messages to other Agents in the last hour. It can send again when the hour's total drops below the limit.",
} as const;

export type AgentDmLimitCode = keyof typeof AGENT_DM_LIMIT_NOTICE;

/** Whether a conversation's latest system message is a limit notice still inside the quiet window. */
export function agentDmIsLimited(
  latestSystem: { body: string; createdAt: Date } | undefined,
  now: Date,
) {
  return (
    latestSystem !== undefined &&
    Object.values<string>(AGENT_DM_LIMIT_NOTICE).includes(latestSystem.body) &&
    now.getTime() - latestSystem.createdAt.getTime() < AGENT_DM_LIMITS.quietMs
  );
}

/**
 * How many of the messages (newest first) belong to the chain ending now: each is less than the
 * quiet window after the one before it, the newest less than that before `now`.
 */
export function agentDmChainLength(createdAtNewestFirst: readonly Date[], now: Date) {
  let next = now.getTime();
  let length = 0;
  for (const createdAt of createdAtNewestFirst) {
    if (next - createdAt.getTime() >= AGENT_DM_LIMITS.quietMs) break;
    length += 1;
    next = createdAt.getTime();
  }
  return length;
}

/**
 * Refuses (`AGENT_DM_CHAIN_LIMIT`, `AGENT_DM_RATE_LIMIT`) a send between two Agents that would pass
 * a limit. Runs inside the send's transaction after the conversation is locked, so two sends into
 * one conversation cannot both pass its chain limit; the hourly total is read without a lock across
 * conversations, so concurrent sends to different peers may overshoot it by their number. System messages are not part of the chain.
 */
export async function assertAgentDmWithinLimits(
  tx: Prisma.TransactionClient,
  input: { conversationId: string; workspaceId: string; senderAgentId: string; now?: Date },
) {
  const now = input.now ?? new Date();
  const recent = await tx.message.findMany({
    where: { conversationId: input.conversationId, senderMemberId: { not: null } },
    orderBy: { sequence: "desc" },
    take: AGENT_DM_LIMITS.chainMessages,
    select: { createdAt: true },
  });
  if (
    agentDmChainLength(
      recent.map((message) => message.createdAt),
      now,
    ) >= AGENT_DM_LIMITS.chainMessages
  )
    throw new AppError("AGENT_DM_CHAIN_LIMIT");
  const sent = await tx.message.count({
    where: {
      workspaceId: input.workspaceId,
      conversation: { directKey: AGENT_PEER_DIRECT_KEY_WHERE },
      sender: { agentId: input.senderAgentId },
      createdAt: { gte: new Date(now.getTime() - HOUR_MS) },
    },
  });
  if (sent >= AGENT_DM_LIMITS.senderPerHour) throw new AppError("AGENT_DM_RATE_LIMIT");
}

/**
 * Writes the notice for `code` into the conversation unless the current chain (its first message
 * on) already has that same notice, so a limit is told once per chain and a refused retry adds
 * nothing. The notice wakes no Agent (it has no delivery): it is for the people who look at the
 * conversation's card.
 */
export async function noteAgentDmLimit(
  db: PrismaClient,
  input: { conversationId: string; workspaceId: string; code: AgentDmLimitCode; now?: Date },
) {
  const { conversationId, workspaceId, code } = input;
  const body = AGENT_DM_LIMIT_NOTICE[code];
  await db.$transaction(async (tx) => {
    await lockConversation(tx, conversationId);
    const recent = await tx.message.findMany({
      where: { conversationId, senderMemberId: { not: null } },
      orderBy: { sequence: "desc" },
      take: AGENT_DM_LIMITS.chainMessages,
      select: { createdAt: true, sequence: true },
    });
    const chain = agentDmChainLength(
      recent.map((message) => message.createdAt),
      input.now ?? new Date(),
    );
    // Told means after the chain's first message, or, with no chain, after the last message.
    const since = (chain > 0 ? recent[chain - 1] : recent[0])?.sequence ?? 0;
    const told = await tx.message.findFirst({
      where: { conversationId, senderMemberId: null, body, sequence: { gt: since } },
      select: { id: true },
    });
    if (told) return;
    const latest = await tx.message.findFirst({
      where: { conversationId },
      orderBy: { sequence: "desc" },
      select: { sequence: true },
    });
    await tx.message.create({
      data: { workspaceId, conversationId, sequence: (latest?.sequence ?? 0) + 1, body },
    });
  });
}
