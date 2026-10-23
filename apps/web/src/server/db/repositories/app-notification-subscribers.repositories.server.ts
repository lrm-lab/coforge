import type { AppNotificationEventName } from "#src/features/apps/app-notification-events";
import type { AppPermissionGroup } from "#src/features/apps/app-permissions";
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

  /** The Workspace's installations whose app has an enabled webhook with an endpoint (not in Setup): the only ones an event has
   * anywhere to go, with what decides which events they are delivered. */
  async installationsOf(workspaceId: string) {
    const rows = await this.db.appInstallation.findMany({
      where: { workspaceId, app: { webhook: { enabled: true, endpointUrl: { not: null } } } },
      select: {
        id: true,
        appId: true,
        approvedGroups: true,
        approvedEvents: true,
        app: { select: { permissionGroups: true, notificationEvents: true } },
      },
      orderBy: { id: "asc" },
    });
    // The CHECK constraints on these columns admit only the four groups and the catalog's events.
    return rows.map((row) => ({
      installationId: row.id,
      appId: row.appId,
      subscribed: row.app.notificationEvents as AppNotificationEventName[],
      approvedEvents: row.approvedEvents as AppNotificationEventName[],
      declaredGroups: row.app.permissionGroups as AppPermissionGroup[],
      approvedGroups: row.approvedGroups as AppPermissionGroup[],
    }));
  }
}
