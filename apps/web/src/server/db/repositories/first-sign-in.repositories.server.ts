import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import type { DatabaseScope } from "#src/server/db/transaction.server";

/** Locks before any confirmed-name or membership read, so concurrent tabs share one winner. */
export function withFirstSignInUser<Result>(
  db: PrismaClient,
  userId: string,
  work: (tx: Prisma.TransactionClient) => Promise<Result>,
) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
    return work(tx);
  });
}

export class PrismaFirstSignInNames {
  constructor(private readonly db: DatabaseScope) {}

  async lookup(userId: string) {
    const row = await this.db.user.findUnique({
      where: { id: userId },
      select: { displayName: true, welcomedAt: true },
    });
    return row && { displayName: row.welcomedAt ? row.displayName : null };
  }

  async confirm(userId: string, displayName: string) {
    const { count } = await this.db.user.updateMany({
      where: { id: userId, welcomedAt: null },
      data: { displayName, welcomedAt: new Date() },
    });
    if (count === 1) return displayName;
    return (
      await this.db.user.findUniqueOrThrow({
        where: { id: userId },
        select: { displayName: true },
      })
    ).displayName;
  }

  async ownsWorkspace(userId: string, workspaceId: string) {
    return Boolean(
      await this.db.workspaceMembership.findFirst({
        where: { userId, workspaceId, role: "owner" },
        select: { userId: true },
      }),
    );
  }
}
