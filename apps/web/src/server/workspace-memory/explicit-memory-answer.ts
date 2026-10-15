/**
 * An explicit @memory question is answered with memory_offer.
 * Citations stay workspace-scoped: a later question may reuse an earlier citation id.
 * The channel and recipient are bound here when the model omits them.
 */

import type { PrismaClient } from "#src/generated/prisma/client";

const EXPLICIT_MEMORY_QUESTION = /(?:^|\s)@memory\b/;

export const DEFAULT_OFFER_RATIONALE = "answers the explicit @memory question";

export function isExplicitMemoryQuestion(body: string, memoryAgentId?: string): boolean {
  if (EXPLICIT_MEMORY_QUESTION.test(body)) return true;
  return (
    memoryAgentId !== undefined &&
    memoryAgentId.length > 0 &&
    body.includes(`<@agent:${memoryAgentId}>`)
  );
}

/** The stored identity token also works after the workspace Memory Agent is renamed. */
export function isExplicitMemoryDiagnosis(body: string, memoryAgentId: string): boolean {
  return (
    /(?:^|\s)@memory\s+diagnose\b/i.test(body) ||
    new RegExp(`(?:^|\\s)<@agent:${memoryAgentId}>\\s+diagnose\\b`, "i").test(body)
  );
}

export function channelSendNeedsMemoryOffer(input: {
  latestQuestionAt: Date | null;
  latestOfferAt: Date | null;
}): boolean {
  if (!input.latestQuestionAt) return false;
  if (!input.latestOfferAt) return true;
  return input.latestOfferAt.getTime() <= input.latestQuestionAt.getTime();
}

export class MemoryOfferTargetError extends Error {
  constructor(message = "memory offer delivery target is unresolved") {
    super(message);
    this.name = "MemoryOfferTargetError";
  }
}

export async function explicitMemoryQuestionRequiresOffer(
  db: PrismaClient,
  input: { workspaceId: string; agentId: string; conversationId: string },
  isDesignated: (workspaceId: string, agentId: string) => Promise<boolean>,
): Promise<boolean> {
  if (!(await isDesignated(input.workspaceId, input.agentId))) return false;
  const question = await oldestUnansweredExplicitMemoryQuestion(
    db,
    input.workspaceId,
    [input.conversationId],
    input.agentId,
  );
  return question !== null;
}

export async function resolveUnansweredMemoryOfferTarget(
  db: PrismaClient,
  workspaceId: string,
  memoryAgentId: string,
): Promise<{ conversationId: string; targetAgentId: string } | null> {
  const memberships = await db.conversationMember.findMany({
    where: {
      workspaceId,
      agentId: memoryAgentId,
      leftAt: null,
      conversation: { channelName: { not: null }, archivedAt: null },
    },
    select: { conversationId: true },
  });
  const conversationIds = memberships.map((membership) => membership.conversationId);
  const question = await oldestUnansweredExplicitMemoryQuestion(
    db,
    workspaceId,
    conversationIds,
    memoryAgentId,
  );
  if (!question) return null;
  if (question.senderAgentId)
    return { conversationId: question.conversationId, targetAgentId: question.senderAgentId };
  const peer = await db.conversationMember.findFirst({
    where: {
      workspaceId,
      conversationId: question.conversationId,
      leftAt: null,
      AND: [{ agentId: { not: null } }, { NOT: { agentId: memoryAgentId } }],
    },
    orderBy: { id: "asc" },
    select: { agentId: true },
  });
  if (!peer?.agentId) return null;
  return { conversationId: question.conversationId, targetAgentId: peer.agentId };
}

/**
 * FIFO offer binding. When several explicit questions are pending, the agent
 * composes for the oldest one it saw; binding the offer to the *newest*
 * unanswered question instead drifts every answer one question behind and the
 * backlog never drains. Each published offer answers at most one question:
 * the oldest unanswered question strictly before it.
 */
export function fifoOldestUnansweredQuestion<T extends { createdAt: Date }>(
  questions: readonly T[],
  offerTimesAsc: readonly Date[],
): T | null {
  let next = 0;
  for (const offer of offerTimesAsc) {
    if (next < questions.length && questions[next].createdAt.getTime() < offer.getTime()) {
      next += 1;
    }
  }
  return questions[next] ?? null;
}

async function oldestUnansweredExplicitMemoryQuestion(
  db: PrismaClient,
  workspaceId: string,
  conversationIds: string[],
  memoryAgentId: string,
): Promise<{ conversationId: string; createdAt: Date; senderAgentId: string | null } | null> {
  if (conversationIds.length === 0) return null;
  const rows = await db.message.findMany({
    where: {
      workspaceId,
      conversationId: { in: conversationIds },
      OR: [{ body: { contains: "@memory" } }, { body: { contains: `<@agent:${memoryAgentId}>` } }],
      sender: {
        OR: [{ userId: { not: null } }, { agentId: { not: null, notIn: [memoryAgentId] } }],
      },
    },
    orderBy: { createdAt: "desc" },
    take: 40,
    select: {
      body: true,
      createdAt: true,
      conversationId: true,
      sender: { select: { agentId: true } },
    },
  });
  const questions = rows
    .filter((row) => isExplicitMemoryQuestion(row.body, memoryAgentId))
    .map((row) => ({
      conversationId: row.conversationId,
      createdAt: row.createdAt,
      senderAgentId: row.sender?.agentId ?? null,
    }))
    .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
  if (questions.length === 0) return null;
  const offers = (
    await db.memoryOfferRecord.findMany({
      where: {
        workspaceId,
        conversationId: { in: conversationIds },
        createdAt: { gte: questions[0].createdAt },
      },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: { createdAt: true },
    })
  ).reverse();
  return fifoOldestUnansweredQuestion(
    questions,
    offers.map((offer) => offer.createdAt),
  );
}
