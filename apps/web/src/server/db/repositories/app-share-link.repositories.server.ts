import type { AppPublishStatus } from "#src/features/apps/app-publish-status";
import type { AppShareLinkStore } from "#src/server/app-marketplace/app-share-links.server";
import { findAppMember } from "#src/server/db/repositories/app.repositories.server";
import { inTransaction, type DatabaseScope } from "#src/server/db/transaction.server";

/** An app's share links: one unrevoked link per app (`app_share_links_one_active`), replaced under
 * a lock on the app's row so two creations cannot race. Who may create or revoke one stays in
 * `server/app-marketplace/`. */
export class PrismaAppShareLinkStore implements AppShareLinkStore {
  constructor(private readonly db: DatabaseScope) {}

  findMember(workspaceId: string, userId: string) {
    return findAppMember(this.db, workspaceId, userId);
  }

  async findOwned(workspaceId: string, key: string) {
    const row = await this.db.app.findFirst({
      where: { key, ownerWorkspaceId: workspaceId },
      select: { id: true, publishStatus: true },
    });
    return row
      ? { appId: row.id, publishStatus: row.publishStatus as AppPublishStatus }
      : undefined;
  }

  async findActive(appId: string, now: Date) {
    const row = await this.db.appShareLink.findFirst({
      where: { appId, revokedAt: null, expiresAt: { gt: now } },
      select: { createdAt: true, expiresAt: true },
    });
    return row ?? undefined;
  }

  replace(input: { appId: string; tokenHash: string; userId: string; at: Date; expiresAt: Date }) {
    return inTransaction(this.db, async (tx) => {
      await tx.$queryRaw`SELECT id FROM apps WHERE id = ${input.appId}::uuid FOR UPDATE`;
      await tx.appShareLink.updateMany({
        where: { appId: input.appId, revokedAt: null },
        data: { revokedAt: input.at },
      });
      await tx.appShareLink.create({
        data: {
          appId: input.appId,
          tokenHash: input.tokenHash,
          createdByUserId: input.userId,
          createdAt: input.at,
          expiresAt: input.expiresAt,
        },
        select: { id: true },
      });
    });
  }

  async revoke(appId: string, at: Date) {
    const { count } = await this.db.appShareLink.updateMany({
      where: { appId, revokedAt: null },
      data: { revokedAt: at },
    });
    return count > 0;
  }
}
