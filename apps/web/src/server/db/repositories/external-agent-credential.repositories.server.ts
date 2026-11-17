import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import type { DatabaseScope } from "#src/server/db/transaction.server";
import type {
  ExternalAgentCredentialRepository,
  ExternalCredentialRevokeReason,
  ExternalPresenceRow,
} from "#src/server/agents/external-agent-credentials.server";

export function revokeExternalCredentialsOf(
  scope: DatabaseScope,
  agentId: string,
  reason: ExternalCredentialRevokeReason,
  at: Date,
): Promise<{ count: number }> {
  return scope.externalAgentCredential.updateMany({
    where: { agentId, revokedAt: null },
    data: { revokedAt: at, revokedReason: reason },
  });
}

export async function readExternalPresence(
  db: Pick<PrismaClient, "$queryRaw">,
  agentIds: readonly string[],
): Promise<ExternalPresenceRow[]> {
  return db.$queryRaw<ExternalPresenceRow[]>`SELECT "agentId",
      (COUNT(*) FILTER (WHERE "revokedAt" IS NULL))::int AS "liveCount",
      MAX("lastUsedAt") FILTER (WHERE "revokedAt" IS NULL) AS "liveLastUsedAt",
      MAX("lastUsedAt") AS "lastUsedAt"
    FROM "external_agent_credentials"
    WHERE "agentId" = ANY(${agentIds as string[]}::uuid[])
    GROUP BY "agentId"`;
}

async function lockAgentRow(tx: Prisma.TransactionClient, agentId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "agents" WHERE "id" = ${agentId}::uuid FOR UPDATE`;
}

export class PrismaExternalAgentCredentialRepository implements ExternalAgentCredentialRepository {
  constructor(private readonly db: PrismaClient) {}

  mint: ExternalAgentCredentialRepository["mint"] = (input) =>
    this.db.$transaction(async (tx) => {
      await lockAgentRow(tx, input.agentId);
      const agent = await tx.agent.findFirst({
        where: { id: input.agentId, workspaceId: input.workspaceId },
        select: { deletedAt: true, stoppedAt: true, hosting: true },
      });
      if (!agent || agent.deletedAt || agent.stoppedAt)
        return { ok: false as const, reason: "agent_unavailable" as const };
      if (agent.hosting !== "external")
        return { ok: false as const, reason: "agent_not_external" as const };
      const replacing = input.source === "app";
      const live = await tx.externalAgentCredential.count({
        where: {
          agentId: input.agentId,
          revokedAt: null,
          ...(replacing ? { source: { not: "app" } } : {}),
        },
      });
      if (live >= input.maxLive) return { ok: false as const, reason: "credential_limit" as const };
      if (replacing)
        await tx.externalAgentCredential.updateMany({
          where: { agentId: input.agentId, source: "app", revokedAt: null },
          data: { revokedAt: new Date(), revokedReason: "replaced" },
        });
      const created = await tx.externalAgentCredential.create({
        data: {
          agentId: input.agentId,
          workspaceId: input.workspaceId,
          approvedByUserId: input.approvedByUserId,
          keyHash: input.keyHash,
          source: input.source,
          ...input.machine,
        },
        select: { id: true },
      });
      return { ok: true as const, id: created.id };
    });

  async findByHash(hash: string) {
    return (
      (await this.db.externalAgentCredential.findUnique({
        where: { keyHash: hash },
        select: {
          id: true,
          keyHash: true,
          agentId: true,
          workspaceId: true,
          lastUsedAt: true,
          revokedAt: true,
          agent: { select: { ownerId: true, deletedAt: true, stoppedAt: true, hosting: true } },
        },
      })) ?? undefined
    );
  }

  async touch(id: string, at: Date, notAfter: Date): Promise<void> {
    await this.db.externalAgentCredential.updateMany({
      where: { id, OR: [{ lastUsedAt: null }, { lastUsedAt: { lte: notAfter } }] },
      data: { lastUsedAt: at },
    });
  }

  async revoke(
    id: string,
    reason: ExternalCredentialRevokeReason,
    at: Date,
    agentId?: string,
  ): Promise<boolean> {
    const { count } = await this.db.externalAgentCredential.updateMany({
      where: { id, revokedAt: null, ...(agentId ? { agentId } : {}) },
      data: { revokedAt: at, revokedReason: reason },
    });
    return count === 1;
  }

  async list(agentId: string) {
    const rows = await this.db.externalAgentCredential.findMany({
      where: { agentId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        source: true,
        machineName: true,
        hostname: true,
        os: true,
        clientName: true,
        createdAt: true,
        lastUsedAt: true,
        revokedAt: true,
        revokedReason: true,
      },
    });
    return rows.map((row) => ({
      ...row,
      source: row.source === "app" ? ("app" as const) : ("device" as const),
    }));
  }

  presence(agentIds: readonly string[]) {
    return readExternalPresence(this.db, agentIds);
  }
}
