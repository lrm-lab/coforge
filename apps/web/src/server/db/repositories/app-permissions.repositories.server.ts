import { hasErrorCode } from "@lrm/coforge-sdk/internal";
import type { AppPermissionGroup } from "#src/features/apps/app-permissions";
import type {
  AppPermissionsStore,
  InstalledAppPermissions,
} from "#src/server/app-permissions/app-permissions.server";
import type { TokenInstallation } from "#src/server/authorization-server/installation-tokens.server";
import { findAppMember } from "#src/server/db/repositories/app.repositories.server";
import { inTransaction, type DatabaseScope } from "#src/server/db/transaction.server";

const INSTALLED = {
  id: true,
  approvedGroups: true,
  approvedRevision: true,
  approvedAt: true,
  app: {
    select: { key: true, ownerWorkspaceId: true, permissionGroups: true, permissionRevision: true },
  },
} as const;

/** An installation by id also names its app and Workspace, for an installation token. */
const INSTALLED_BY_ID = {
  ...INSTALLED,
  appId: true,
  workspaceId: true,
  workspace: { select: { slug: true } },
} as const;

type InstalledRow = {
  id: string;
  approvedGroups: string[];
  approvedRevision: number;
  approvedAt: Date | null;
  app: {
    key: string;
    ownerWorkspaceId: string;
    permissionGroups: string[];
    permissionRevision: number;
  };
};

/** A row as the module sees it: `apps_permission_groups_check` and
 * `app_installations_approved_groups_check` admit only the four groups. */
const installed = ({ app, ...installation }: InstalledRow): InstalledAppPermissions => ({
  key: app.key,
  installationId: installation.id,
  ownerWorkspaceId: app.ownerWorkspaceId,
  declared: app.permissionGroups as AppPermissionGroup[],
  revision: app.permissionRevision,
  approved: installation.approvedGroups as AppPermissionGroup[],
  approvedRevision: installation.approvedRevision,
  approvedAt: installation.approvedAt,
});

/** App permission rows: each write is one compare-and-set on the app's `permissionRevision`, and
 * a declaration is one transaction (the caller's, when `db` is one). Who may write, and the group rules, stay in `server/app-permissions/`. */
export class PrismaAppPermissionsStore implements AppPermissionsStore {
  constructor(private readonly db: DatabaseScope) {}

  findMember(workspaceId: string, userId: string) {
    return findAppMember(this.db, workspaceId, userId);
  }

  async listInstalled(workspaceId: string) {
    const rows = await this.db.appInstallation.findMany({
      where: { workspaceId },
      select: INSTALLED,
    });
    return rows.map(installed);
  }

  async findInstalled(workspaceId: string, key: string) {
    const row = await this.db.appInstallation.findFirst({
      where: { workspaceId, app: { key } },
      select: INSTALLED,
    });
    return row ? installed(row) : undefined;
  }

  /** An installation by id, as an installation token sees it. */
  async findInstallation(id: string): Promise<TokenInstallation | undefined> {
    const row = await this.db.appInstallation.findUnique({
      where: { id },
      select: INSTALLED_BY_ID,
    });
    if (!row) return undefined;
    const { declared, approved } = installed(row);
    return {
      id: row.id,
      appId: row.appId,
      appKey: row.app.key,
      workspaceId: row.workspaceId,
      workspaceSlug: row.workspace.slug,
      declared,
      approved,
    };
  }

  async declare(input: {
    ownerWorkspaceId: string;
    key: string;
    groups: AppPermissionGroup[];
    revision: number;
  }) {
    return inTransaction(this.db, async (tx) => {
      let appId: string;
      try {
        ({ id: appId } = await tx.app.update({
          where: {
            key: input.key,
            ownerWorkspaceId: input.ownerWorkspaceId,
            permissionRevision: input.revision,
          },
          data: { permissionGroups: input.groups, permissionRevision: { increment: 1 } },
          select: { id: true },
        }));
      } catch (error) {
        // P2025: not at that revision, or no such app of this Workspace.
        if (hasErrorCode(error, "P2025")) return false;
        throw error;
      }
      // Each approval keeps, in its order, only the groups still declared. One statement per row,
      // so an approval committed meanwhile is re-read under the row lock and narrowed too.
      await tx.$executeRaw`
        UPDATE "app_installations" AS installation
        SET "approvedGroups" = ARRAY(
          SELECT approved.group_name
          FROM unnest(installation."approvedGroups") WITH ORDINALITY AS approved(group_name, position)
          WHERE approved.group_name = ANY(${input.groups}::TEXT[])
          ORDER BY approved.position
        )
        WHERE installation."appId" = ${appId}::uuid
          AND NOT (installation."approvedGroups" <@ ${input.groups}::TEXT[])`;
      return true;
    });
  }

  async approve(input: {
    workspaceId: string;
    key: string;
    groups: AppPermissionGroup[];
    revision: number;
    userId: string;
    at: Date;
  }) {
    const { count } = await this.db.appInstallation.updateMany({
      where: {
        workspaceId: input.workspaceId,
        app: { key: input.key, permissionRevision: input.revision },
      },
      data: {
        approvedGroups: input.groups,
        approvedRevision: input.revision,
        approvedAt: input.at,
        approvedByUserId: input.userId,
      },
    });
    return count === 1;
  }
}
