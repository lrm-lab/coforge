import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";

type Db = PrismaClient | Prisma.TransactionClient;

export async function requireMembership(db: Db, workspaceId: string, userId: string) {
  const row = await db.workspaceMembership.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { role: true },
  });
  if (!row) throw new AppError("ACCESS_DENIED");
  return row;
}

/** Weekly report configuration is intentionally open to Workspace members during MVP rollout. */
export async function requireWeeklyReportLeader(db: Db, workspaceId: string, userId: string) {
  return requireMembership(db, workspaceId, userId);
}
