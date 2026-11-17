import type { Prisma } from "#src/generated/prisma/client";
import { TeamMemoryError, type TeamMemoryActor } from "#src/server/team-memory/memory";

type ReceiptData = {
  reviewToken?: string | null;
  reviewRevision?: number;
  reviewExpiresAt?: Date | null;
  entryId?: string;
  deleted?: boolean;
};
export function memoryReceipts(
  db: Prisma.TransactionClient,
  actor: TeamMemoryActor,
  requestId: string,
) {
  const common = { workspaceId: actor.workspaceId, requestId };
  if (actor.userId) {
    const key = { ...common, userId: actor.userId };
    const where = { workspaceId_userId_requestId: key };
    return {
      get: () => db.teamMemoryUserReceipt.findUnique({ where }),
      review: (fingerprint: string, data: ReceiptData) =>
        db.teamMemoryUserReceipt.upsert({
          where,
          create: { ...key, fingerprint, ...data },
          update: data,
        }),
      update: (data: ReceiptData) => db.teamMemoryUserReceipt.update({ where, data }),
      prune: () =>
        db.$executeRaw`DELETE FROM team_memory_user_receipts WHERE (workspace_id, user_id, request_id) IN (SELECT workspace_id, user_id, request_id FROM team_memory_user_receipts WHERE workspace_id = ${actor.workspaceId}::uuid AND user_id = ${actor.userId}::uuid AND entry_id IS NULL AND review_expires_at < now() LIMIT 100)`,
    };
  }
  if (!actor.agentId) throw new TeamMemoryError("forbidden");
  const key = { ...common, agentId: actor.agentId };
  const where = { workspaceId_agentId_requestId: key };
  return {
    get: () => db.teamMemoryReceipt.findUnique({ where }),
    review: (fingerprint: string, data: ReceiptData) =>
      db.teamMemoryReceipt.upsert({
        where,
        create: { ...key, fingerprint, ...data },
        update: data,
      }),
    update: (data: ReceiptData) => db.teamMemoryReceipt.update({ where, data }),
    prune: () =>
      db.$executeRaw`DELETE FROM team_memory_receipts WHERE (workspace_id, agent_id, request_id) IN (SELECT workspace_id, agent_id, request_id FROM team_memory_receipts WHERE workspace_id = ${actor.workspaceId}::uuid AND agent_id = ${actor.agentId}::uuid AND entry_id IS NULL AND review_expires_at < now() LIMIT 100)`,
  };
}
