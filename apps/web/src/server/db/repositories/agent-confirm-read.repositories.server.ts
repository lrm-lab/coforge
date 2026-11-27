import { AppError } from "#src/lib/app-error";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { advanceAgentReadPosition } from "./agent-read-position.repositories.server";
import { readThroughOf } from "./thread-read-position.server";

type Scope = {
  workspaceId: string;
  agentId: string;
  conversationId: string;
  threadRootId?: string;
  signedMemberId: string | null;
  boardMemberId?: string;
  taskId?: string;
  base: number;
  through: number;
  publishConversationRead: boolean;
};

type ReadSeat = { id: string; agentReadThroughSequence: number };

async function lockSeat(db: Prisma.TransactionClient, scope: Scope, memberId: string) {
  const [row] = await db.$queryRaw<ReadSeat[]>`
    SELECT "id", "agentReadThroughSequence"
    FROM "conversation_members"
    WHERE "id" = ${memberId}::uuid AND "agentId" = ${scope.agentId}::uuid
      AND "workspaceId" = ${scope.workspaceId}::uuid AND "leftAt" IS NULL
    FOR UPDATE`;
  if (!row) throw new AppError("NOT_FOUND");
  return row;
}

async function authorizedSeat(tx: Prisma.TransactionClient, scope: Scope) {
  const { workspaceId, conversationId, agentId, taskId, boardMemberId, signedMemberId } = scope;
  if (taskId && boardMemberId) {
    await lockSeat(tx, scope, boardMemberId);
    const live = await tx.task.findFirst({
      where: { id: taskId, workspaceId, discussionConversationId: conversationId, deletedAt: null },
      select: { id: true },
    });
    if (!live) throw new AppError("NOT_FOUND");
  }
  const key = { conversationId_agentId: { conversationId, agentId } };
  const seat = await tx.conversationMember.findUnique({ where: key, select: { id: true } });
  if (seat) {
    if (signedMemberId && signedMemberId !== seat.id) throw new AppError("NOT_FOUND");
    return lockSeat(tx, scope, seat.id);
  }
  if (signedMemberId || !taskId || !boardMemberId || scope.base !== 0)
    throw new AppError("NOT_FOUND");
  const created = await tx.conversationMember.upsert({
    where: key,
    create: { conversationId, workspaceId, agentId },
    update: {},
    select: { id: true },
  });
  return lockSeat(tx, scope, created.id);
}

export function confirmAgentReadPosition(db: PrismaClient, scope: Scope) {
  return db.$transaction(async (tx) => {
    const member = await authorizedSeat(tx, scope);
    const root = scope.threadRootId ?? null;
    const current = await readThroughOf(tx, member.id, member.agentReadThroughSequence, root);
    if (current < scope.base) throw new AppError("CONFLICT");
    if (current >= scope.through) return { readThrough: current };
    const publication = await advanceAgentReadPosition({
      ...scope,
      db: tx,
      memberId: member.id,
      sequence: scope.through,
    });
    return {
      readThrough: root
        ? await readThroughOf(tx, member.id, member.agentReadThroughSequence, root)
        : scope.through,
      publication,
    };
  });
}
