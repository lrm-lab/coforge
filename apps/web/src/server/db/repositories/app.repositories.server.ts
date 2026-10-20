import { hasErrorCode } from "@lrm/coforge-sdk/internal";
import type { PrismaClient } from "#src/generated/prisma/client";
import type { AppCategory } from "#src/features/apps/app-category";
import type { AppRegistrationInput } from "#src/features/apps/app-registration";
import type { AppChange, AppRegistryStore, AppView } from "#src/server/apps/app-registry.server";
import { isUniqueViolation } from "#src/server/db/unique-violation.server";
import { isWorkspaceMemberRole } from "#src/server/workspaces/member-role.server";

/** Every column but the secret hash: a read for display never carries it. */
const APP_VIEW = {
  key: true,
  ownerWorkspaceId: true,
  name: true,
  description: true,
  whenToUse: true,
  homepageUrl: true,
  redirectUris: true,
  category: true,
  allowedScopes: true,
  logoObjectKey: true,
  secretRotatedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** A row as the registry sees it: `apps_category_check` admits only the nine categories. */
const view = (row: Omit<AppView, "category"> & { category: string }): AppView => ({
  ...row,
  category: row.category as AppCategory,
});

/** The one app `key` that `workspaceId` owns: every write is scoped by it, so none can reach
 * another Workspace's. */
const owned = (workspaceId: string, key: string) => ({ key, ownerWorkspaceId: workspaceId });

/** App registry rows; who may change which app, and input rules, stay in `server/apps/`. */
export class PrismaAppRegistryStore implements AppRegistryStore {
  constructor(private readonly db: PrismaClient) {}

  async findMemberRole(workspaceId: string, userId: string) {
    const row = await this.db.workspaceMembership.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { role: true },
    });
    return row && isWorkspaceMemberRole(row.role) ? row.role : undefined;
  }

  async listForWorkspace(workspaceId: string) {
    const rows = await this.db.app.findMany({
      where: { installations: { some: { workspaceId } } },
      select: APP_VIEW,
      orderBy: [{ name: "asc" }, { key: "asc" }],
    });
    return rows.map(view);
  }

  async find(key: string) {
    const row = await this.db.app.findUnique({ where: { key }, select: APP_VIEW });
    return row ? view(row) : undefined;
  }

  async create(input: {
    app: AppRegistrationInput;
    workspaceId: string;
    userId: string;
    clientSecretHash: string;
  }) {
    try {
      const row = await this.db.app.create({
        data: {
          ...input.app,
          ownerWorkspaceId: input.workspaceId,
          createdByUserId: input.userId,
          clientSecretHash: input.clientSecretHash,
          installations: {
            create: { workspaceId: input.workspaceId, installedByUserId: input.userId },
          },
        },
        select: APP_VIEW,
      });
      return view(row);
    } catch (error) {
      if (isUniqueViolation(error)) return undefined;
      throw error;
    }
  }

  async update(workspaceId: string, key: string, change: AppChange) {
    try {
      const row = await this.db.app.update({
        where: owned(workspaceId, key),
        data: change,
        select: APP_VIEW,
      });
      return view(row);
    } catch (error) {
      // P2025: no such app of this Workspace.
      if (hasErrorCode(error, "P2025")) return undefined;
      throw error;
    }
  }

  async delete(workspaceId: string, key: string) {
    try {
      return await this.db.app.delete({
        where: owned(workspaceId, key),
        select: { logoObjectKey: true },
      });
    } catch (error) {
      if (hasErrorCode(error, "P2025")) return undefined;
      throw error;
    }
  }

  async replaceLogo(
    workspaceId: string,
    key: string,
    from: string | null,
    to: { objectKey: string; contentType: string } | null,
  ) {
    const { count } = await this.db.app.updateMany({
      where: { ...owned(workspaceId, key), logoObjectKey: from },
      data: { logoObjectKey: to?.objectKey ?? null, logoContentType: to?.contentType ?? null },
    });
    return count === 1;
  }

  async findLogo({
    workspaceId,
    key,
    viewerUserId,
  }: {
    workspaceId: string;
    key: string;
    viewerUserId: string;
  }) {
    const row = await this.db.app.findFirst({
      where: {
        ...owned(workspaceId, key),
        installations: { some: { workspace: { members: { some: { userId: viewerUserId } } } } },
      },
      select: { logoObjectKey: true, logoContentType: true },
    });
    if (!row?.logoObjectKey || !row.logoContentType) return undefined;
    return { objectKey: row.logoObjectKey, contentType: row.logoContentType };
  }
}
