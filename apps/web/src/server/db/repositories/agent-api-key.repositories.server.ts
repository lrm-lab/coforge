import type { PrismaClient } from "#src/generated/prisma/client";
import type {
  AgentApiKeyMintInput,
  AgentApiKeyRecord,
  AgentApiKeyRepository,
} from "#src/server/agents/agent-api-key.server";

export class PrismaAgentApiKeyRepository implements AgentApiKeyRepository {
  constructor(private readonly db: PrismaClient) {}

  async rotate(record: AgentApiKeyMintInput): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "agents" WHERE "id" = ${record.agentId}::uuid FOR UPDATE`;
      // Overlap rotation: the newest earlier key stays valid until the new one first
      // authenticates; anything older is revoked now. The newest is picked across revoked
      // records too — a key revoked before its first use must not resurrect the key before it
      // on the next mint — and a key minted on another Computer never survives a new mint,
      // closing the stale key a migration left behind.
      const newest = await tx.agentApiKey.findFirst({
        where: {
          agentId: record.agentId,
          workspaceId: record.workspaceId,
          ownerId: record.ownerId,
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { id: true, computerId: true, revokedAt: true, disabledAt: true },
      });
      const keep =
        newest && !newest.revokedAt && !newest.disabledAt && newest.computerId === record.computerId
          ? newest.id
          : undefined;
      await tx.agentApiKey.updateMany({
        where: {
          agentId: record.agentId,
          workspaceId: record.workspaceId,
          ownerId: record.ownerId,
          revokedAt: null,
          ...(keep ? { id: { not: keep } } : {}),
        },
        data: { revokedAt: new Date() },
      });
      await tx.agentApiKey.create({ data: record });
    });
  }

  async findByHash(hash: string): Promise<AgentApiKeyRecord | undefined> {
    return (await this.db.agentApiKey.findUnique({ where: { apiKeyHash: hash } })) ?? undefined;
  }

  async revokeOlderKeys(record: AgentApiKeyRecord): Promise<void> {
    await this.db.$transaction(async (tx) => {
      // The used mark lands with the retire in one transaction, so a request that settles
      // never settles twice.
      await tx.agentApiKey.updateMany({
        where: { id: record.id, firstUsedAt: null },
        data: { firstUsedAt: new Date() },
      });
      await tx.agentApiKey.updateMany({
        where: {
          agentId: record.agentId,
          workspaceId: record.workspaceId,
          revokedAt: null,
          OR: [
            { createdAt: { lt: record.createdAt } },
            // uuid(7) ids order a same-millisecond `createdAt` tie by creation.
            { createdAt: record.createdAt, id: { lt: record.id } },
          ],
        },
        data: { revokedAt: new Date() },
      });
    });
  }

  async revoke(id: string): Promise<void> {
    await this.db.agentApiKey.updateMany({
      where: { id },
      data: { revokedAt: new Date() },
    });
  }

  async revokeAll(record: AgentApiKeyRecord): Promise<void> {
    await this.db.agentApiKey.updateMany({
      where: {
        agentId: record.agentId,
        workspaceId: record.workspaceId,
        ownerId: record.ownerId,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });
  }
}
