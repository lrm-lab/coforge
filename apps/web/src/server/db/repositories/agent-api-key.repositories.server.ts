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
      // authenticates; anything older is revoked now.
      const newest = await tx.agentApiKey.findFirst({
        where: {
          agentId: record.agentId,
          workspaceId: record.workspaceId,
          ownerId: record.ownerId,
          revokedAt: null,
          disabledAt: null,
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { id: true },
      });
      await tx.agentApiKey.updateMany({
        where: {
          agentId: record.agentId,
          workspaceId: record.workspaceId,
          ownerId: record.ownerId,
          revokedAt: null,
          ...(newest ? { id: { not: newest.id } } : {}),
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
    await this.db.agentApiKey.updateMany({
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
  }

  async revoke(id: string): Promise<void> {
    await this.db.agentApiKey.updateMany({
      where: { id },
      data: { revokedAt: new Date() },
    });
  }
}
