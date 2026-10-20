import type { PrismaClient } from "#src/generated/prisma/client";
import type {
  DaemonApiKeyMint,
  DaemonApiKeyRecord,
  DaemonApiKeyRepository,
} from "#src/server/auth/daemon-api-key.server";

export class PrismaDaemonApiKeyRepository implements DaemonApiKeyRepository {
  constructor(private readonly db: PrismaClient) {}

  async replaceActive(record: DaemonApiKeyMint): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "computers" WHERE "id" = ${record.computerId}::uuid FOR UPDATE`;
      await tx.daemonApiKey.updateMany({
        where: {
          computerId: record.computerId,
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      });
      await tx.daemonApiKey.create({ data: record });
    });
  }

  /** One statement: the key by its unique hash, and its owner's membership of its Workspace by
   * that table's primary key. Prisma's relation filters cannot compare two columns of the row. */
  async findByHash(hash: string): Promise<DaemonApiKeyRecord | undefined> {
    const [record] = await this.db.$queryRaw<DaemonApiKeyRecord[]>`
      SELECT
        k."id"::text AS "id",
        k."api_key_hash" AS "apiKeyHash",
        k."workspace_id"::text AS "workspaceId",
        k."computer_id"::text AS "computerId",
        k."owner_id"::text AS "ownerId",
        k."revoked_at" AS "revokedAt",
        k."last_used_at" AS "lastUsedAt",
        EXISTS (
          SELECT 1 FROM "workspace_memberships" m
          WHERE m."workspaceId" = k."workspace_id" AND m."userId" = k."owner_id"
        ) AS "ownerIsMember"
      FROM "daemon_api_keys" k
      WHERE k."api_key_hash" = ${hash}`;
    return record;
  }

  async markUsed(id: string, at: Date): Promise<void> {
    await this.db.daemonApiKey.update({
      where: { id },
      data: { lastUsedAt: at },
    });
  }
}
