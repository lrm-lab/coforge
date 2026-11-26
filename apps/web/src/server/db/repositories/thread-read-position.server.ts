import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import {
  READ_ADVANCE_COALESCE_MS,
  recordReadAdvance,
} from "#src/server/conversations/human-unread.server";

export async function advanceThreadRead(
  client: Prisma.TransactionClient | PrismaClient,
  memberId: string,
  conversationId: string,
  workspaceId: string,
  rootMessageId: string,
  sequence: number,
): Promise<boolean> {
  const affected = await client.$executeRaw`INSERT INTO "thread_reads"
    ("memberId", "conversationId", "workspaceId", "rootMessageId", "readThroughSequence")
    VALUES (${memberId}::uuid, ${conversationId}::uuid, ${workspaceId}::uuid, ${rootMessageId}::uuid, ${sequence})
    ON CONFLICT ("memberId", "rootMessageId") DO UPDATE SET "readThroughSequence" = EXCLUDED."readThroughSequence"
    WHERE EXCLUDED."readThroughSequence" > "thread_reads"."readThroughSequence"`;
  return affected > 0;
}

export async function readThroughOf(
  db: Pick<PrismaClient, "threadRead">,
  memberId: string,
  conversationReadThrough: number,
  threadRootId: string | null,
) {
  if (!threadRootId) return conversationReadThrough;
  const threadRead = await db.threadRead.findUnique({
    where: { memberId_rootMessageId: { memberId, rootMessageId: threadRootId } },
    select: { readThroughSequence: true },
  });
  return threadRead?.readThroughSequence ?? 0;
}

export async function advanceAgentRead(
  db: Prisma.TransactionClient | PrismaClient,
  read: {
    memberId: string;
    conversationId: string;
    workspaceId: string;
    agentId: string;
    threadRootId: string | null;
    sequence: number;
  },
) {
  const { memberId, conversationId, workspaceId, agentId, threadRootId, sequence } = read;
  if (threadRootId) {
    await advanceThreadRead(db, memberId, conversationId, workspaceId, threadRootId, sequence);
    return true;
  }
  const result = await db.conversationMember.updateMany({
    where: { conversationId, agentId, agentReadThroughSequence: { lt: sequence } },
    data: { agentReadThroughSequence: sequence },
  });
  if (result.count > 0 && memberId)
    await recordReadAdvance(db, { conversationId, memberId, sequence });
  return result.count > 0;
}

export type DirectReadAdvance = {
  conversationId: string;
  memberId: string;
  sequence: number;
};

export async function recordReadAdvances(
  tx: Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw" | "messageRead">,
  workspaceId: string,
  advances: readonly DirectReadAdvance[],
  at: Date = new Date(),
): Promise<void> {
  const deduped = new Map<string, DirectReadAdvance>();
  for (const advance of advances) {
    if (advance.sequence < 1 || !advance.memberId) continue;
    const key = `${advance.conversationId}:${advance.memberId}`;
    const existing = deduped.get(key);
    if (!existing || advance.sequence > existing.sequence) deduped.set(key, advance);
  }
  if (deduped.size === 0) return;
  const rows = [...deduped.values()];
  const latest = await tx.$queryRaw<
    Array<{
      id: string;
      conversationId: string;
      memberId: string;
      sequence: number;
      readAt: Date;
    }>
  >`
    SELECT DISTINCT ON (mr."conversationId", mr."memberId")
      mr."id", mr."conversationId", mr."memberId", mr."sequence", mr."readAt"
    FROM "message_reads" mr
    JOIN unnest(
      ${rows.map((row) => row.conversationId)}::uuid[],
      ${rows.map((row) => row.memberId)}::uuid[]
    ) AS v("conversationId", "memberId")
      ON mr."conversationId" = v."conversationId" AND mr."memberId" = v."memberId"
    ORDER BY mr."conversationId", mr."memberId", mr."readAt" DESC`;
  const latestByKey = new Map(latest.map((row) => [`${row.conversationId}:${row.memberId}`, row]));
  const toUpdate: Array<{ id: string; sequence: number }> = [];
  const toInsert: Array<{
    workspaceId: string;
    conversationId: string;
    memberId: string;
    sequence: number;
    readAt: Date;
  }> = [];
  for (const row of rows) {
    const last = latestByKey.get(`${row.conversationId}:${row.memberId}`);
    if (last && at.getTime() - new Date(last.readAt).getTime() < READ_ADVANCE_COALESCE_MS) {
      if (row.sequence > last.sequence) toUpdate.push({ id: last.id, sequence: row.sequence });
      continue;
    }
    toInsert.push({
      workspaceId,
      conversationId: row.conversationId,
      memberId: row.memberId,
      sequence: row.sequence,
      readAt: at,
    });
  }
  if (toUpdate.length > 0) {
    toUpdate.sort((a, b) => a.id.localeCompare(b.id));
    await tx.$executeRaw`UPDATE "message_reads" AS mr
      SET "sequence" = v."sequence", "readAt" = ${at}
      FROM unnest(
        ${toUpdate.map((row) => row.id)}::uuid[],
        ${toUpdate.map((row) => row.sequence)}::int[]
      ) AS v("id", "sequence")
      WHERE mr."id" = v."id"
        AND mr."sequence" < v."sequence"`;
  }
  if (toInsert.length > 0) {
    await tx.messageRead.createMany({ data: toInsert });
  }
}

export type BatchedAgentReadItem = {
  memberId: string;
  conversationId: string;
  threadRootId: string | null;
  sequence: number;
  isDirect: boolean;
};

export async function advanceAgentReadsBatch(
  tx: Prisma.TransactionClient | PrismaClient,
  input: {
    workspaceId: string;
    agentId: string;
    items: readonly BatchedAgentReadItem[];
  },
): Promise<Set<string>> {
  const threadMap = new Map<string, BatchedAgentReadItem>();
  const convMap = new Map<string, BatchedAgentReadItem>();
  for (const item of input.items) {
    if (item.threadRootId) {
      const key = `${item.memberId}:${item.threadRootId}`;
      const existing = threadMap.get(key);
      if (!existing || item.sequence > existing.sequence) threadMap.set(key, item);
    } else {
      const existing = convMap.get(item.conversationId);
      if (!existing || item.sequence > existing.sequence) convMap.set(item.conversationId, item);
    }
  }
  if (threadMap.size > 0) {
    const threads = [...threadMap.values()].sort(
      (a, b) =>
        a.memberId.localeCompare(b.memberId) || a.threadRootId!.localeCompare(b.threadRootId!),
    );
    await tx.$executeRaw`INSERT INTO "thread_reads"
      ("memberId", "conversationId", "workspaceId", "rootMessageId", "readThroughSequence")
      SELECT t."memberId", t."conversationId", ${input.workspaceId}::uuid, t."rootMessageId", t."sequence"
      FROM unnest(
        ${threads.map((row) => row.memberId)}::uuid[],
        ${threads.map((row) => row.conversationId)}::uuid[],
        ${threads.map((row) => row.threadRootId!)}::uuid[],
        ${threads.map((row) => row.sequence)}::int[]
      ) AS t("memberId", "conversationId", "rootMessageId", "sequence")
      ON CONFLICT ("memberId", "rootMessageId") DO UPDATE SET "readThroughSequence" = EXCLUDED."readThroughSequence"
      WHERE EXCLUDED."readThroughSequence" > "thread_reads"."readThroughSequence"`;
  }
  const advancedConversations = new Set<string>();
  if (convMap.size > 0) {
    const convs = [...convMap.values()].sort((a, b) =>
      a.conversationId.localeCompare(b.conversationId),
    );
    const updated = await tx.$queryRaw<Array<{ conversationId: string }>>`
      UPDATE "conversation_members" AS m
      SET "agentReadThroughSequence" = v."sequence"
      FROM unnest(
        ${convs.map((row) => row.conversationId)}::uuid[],
        ${convs.map((row) => row.sequence)}::int[]
      ) AS v("conversationId", "sequence")
      WHERE m."conversationId" = v."conversationId"
        AND m."agentId" = ${input.agentId}::uuid
        AND m."agentReadThroughSequence" < v."sequence"
      RETURNING m."conversationId"`;
    const dmAdvances: DirectReadAdvance[] = [];
    for (const row of updated) {
      advancedConversations.add(row.conversationId);
      const item = convMap.get(row.conversationId);
      if (item?.isDirect && item.memberId) {
        dmAdvances.push({
          conversationId: item.conversationId,
          memberId: item.memberId,
          sequence: item.sequence,
        });
      }
    }
    if (dmAdvances.length > 0) await recordReadAdvances(tx, input.workspaceId, dmAdvances);
  }
  return advancedConversations;
}
