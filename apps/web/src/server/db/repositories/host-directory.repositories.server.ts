import type { PrismaClient } from "#src/generated/prisma/client";
import type { ClusterRecord, ClusterStore } from "#src/server/hosts/host-directory.server";

export class PrismaHostStore implements ClusterStore {
  constructor(private readonly db: PrismaClient) {}

  async insert(record: ClusterRecord): Promise<void> {
    await this.db.hostNode.create({ data: record });
  }

  async findByTokenHash(tokenHash: string): Promise<ClusterRecord | undefined> {
    return (await this.db.hostNode.findUnique({ where: { tokenHash } })) ?? undefined;
  }

  async findByNodeKey(nodeKey: string): Promise<ClusterRecord | undefined> {
    return (await this.db.hostNode.findUnique({ where: { nodeKey } })) ?? undefined;
  }

  async save(record: ClusterRecord): Promise<void> {
    await this.db.hostNode.update({
      where: { id: record.id },
      data: {
        name: record.name,
        nodeKey: record.nodeKey,
        lastSeenAt: record.lastSeenAt,
        accepting: record.accepting,
      },
    });
  }
}
