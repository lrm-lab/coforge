import {
  isDaemonConnectRejectionReason,
  type DaemonConnectRejectionReason,
} from "@lrm/coforge-sdk/internal";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";

export const DAEMON_CREDENTIAL_REVOCATION_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export class DaemonCredentialRevocations {
  constructor(
    private readonly db: PrismaClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  static recordForWorkspace(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    now: Date = new Date(),
  ): Promise<number> {
    return record(tx, { workspaceId }, "workspace_deleted", now);
  }

  static recordForComputer(
    tx: Prisma.TransactionClient,
    scope: { workspaceId: string; computerId: string },
    now: Date = new Date(),
  ): Promise<number> {
    return record(tx, scope, "computer_unlinked", now);
  }

  static recordForComputerWorkspaces(
    tx: Prisma.TransactionClient,
    scope: { workspaceIds: readonly string[]; computerId: string },
    now: Date = new Date(),
  ): Promise<number> {
    const ids = [...new Set(scope.workspaceIds)];
    if (ids.length === 0) return Promise.resolve(0);
    return record(
      tx,
      { workspaceId: { in: ids }, computerId: scope.computerId },
      "computer_unlinked",
      now,
    );
  }

  static recordForMember(
    tx: Prisma.TransactionClient,
    scope: { workspaceId: string; userId: string },
    now: Date = new Date(),
  ): Promise<number> {
    return record(
      tx,
      { workspaceId: scope.workspaceId, ownerId: scope.userId },
      "computer_unlinked",
      now,
    );
  }

  async reasonFor(apiKeyHash: string): Promise<DaemonConnectRejectionReason | undefined> {
    const revocation = await this.db.daemonCredentialRevocation.findFirst({
      where: { apiKeyHash, revokedAt: { gt: retentionCutoff(this.now()) } },
      select: { reason: true },
    });
    return revocation && isDaemonConnectRejectionReason(revocation.reason)
      ? revocation.reason
      : undefined;
  }
}

async function record(
  tx: Prisma.TransactionClient,
  scope: { workspaceId: string | { in: string[] }; computerId?: string; ownerId?: string },
  reason: DaemonConnectRejectionReason,
  now: Date,
): Promise<number> {
  const keys = await tx.daemonApiKey.findMany({
    where: { ...scope, revokedAt: null },
    select: { apiKeyHash: true },
  });
  await tx.daemonCredentialRevocation.deleteMany({
    where: { revokedAt: { lte: retentionCutoff(now) } },
  });
  if (!keys.length) return 0;
  const { count } = await tx.daemonCredentialRevocation.createMany({
    data: keys.map(({ apiKeyHash }) => ({ apiKeyHash, reason, revokedAt: now })),
    skipDuplicates: true,
  });
  return count;
}

function retentionCutoff(now: Date): Date {
  return new Date(now.getTime() - DAEMON_CREDENTIAL_REVOCATION_RETENTION_MS);
}
