import type { DatabaseScope } from "#src/server/db/transaction.server";

/** Reads who an app notification is for. */
export class PrismaAppNotificationSubscribers {
  constructor(private readonly db: DatabaseScope) {}

  findWorkspace(workspaceId: string) {
    return this.db.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, slug: true },
    });
  }

  /** The Workspace's installations whose app has an enabled webhook: the only ones an event has
   * anywhere to go. */
  async installationsOf(workspaceId: string) {
    const rows = await this.db.appInstallation.findMany({
      where: { workspaceId, app: { webhook: { enabled: true } } },
      select: { id: true, appId: true },
      orderBy: { id: "asc" },
    });
    return rows.map((row) => ({ installationId: row.id, appId: row.appId }));
  }
}
