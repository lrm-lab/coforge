import { hasErrorCode } from "@lrm/coforge-sdk/internal";
import type { Prisma } from "#src/generated/prisma/client";
import type { AppCategory } from "#src/features/apps/app-category";
import {
  DELETABLE_STATUSES,
  LISTED_STATUSES,
  type AppPublishStatus,
} from "#src/features/apps/app-publish-status";
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
  agentManifestUrl: true,
  redirectUris: true,
  category: true,
  allowedScopes: true,
  logoObjectKey: true,
  publishStatus: true,
  secretRotatedAt: true,
  createdAt: true,
  updatedAt: true,
  ownerWorkspace: { select: { name: true } },
} as const;

/** A row as the registry sees it: `apps_category_check` admits only the nine categories. */
const view = ({
  ownerWorkspace,
  ...row
}: Omit<AppView, "category" | "publishStatus" | "developer"> & {
  category: string;
  publishStatus: string;
  ownerWorkspace: { name: string };
}): AppView => ({
  ...row,
  category: row.category as AppCategory,
  publishStatus: row.publishStatus as AppPublishStatus,
  developer: ownerWorkspace.name,
});

/** The one app `key` that `workspaceId` owns: every write is scoped by it, so none can reach
 * another Workspace's. */
const owned = (workspaceId: string, key: string) => ({ key, ownerWorkspaceId: workspaceId });

/** The person's role in the Workspace and the Workspace's slug (a feature-flag rule may match it);
 * `undefined` for a non-member. The one membership read of the app modules. */
export async function findAppMember(
  db: Prisma.TransactionClient,
  workspaceId: string,
  userId: string,
) {
  const row = await db.workspaceMembership.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { role: true, workspace: { select: { slug: true } } },
  });
  return row && isWorkspaceMemberRole(row.role)
    ? { role: row.role, workspaceSlug: row.workspace.slug }
    : undefined;
}

/** App registry rows; who may change which app, and input rules, stay in `server/apps/`. */
export class PrismaAppRegistryStore implements AppRegistryStore {
  constructor(private readonly db: Prisma.TransactionClient) {}

  findMember(workspaceId: string, userId: string) {
    return findAppMember(this.db, workspaceId, userId);
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
        where: { ...owned(workspaceId, key), publishStatus: { in: [...DELETABLE_STATUSES] } },
        select: { logoObjectKey: true },
      });
    } catch (error) {
      if (!hasErrorCode(error, "P2025")) throw error;
      // Nothing deleted: the app is not there, or it moved to a status that cannot be deleted.
      const present = await this.db.app.findFirst({
        where: owned(workspaceId, key),
        select: { id: true },
      });
      return present ? ("blocked" as const) : undefined;
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
        // A member of a Workspace where it is installed, or any signed-in person while the app is
        // listed: the Marketplace shows its logo before an install.
        OR: [
          {
            installations: { some: { workspace: { members: { some: { userId: viewerUserId } } } } },
          },
          { publishStatus: { in: [...LISTED_STATUSES] } },
        ],
      },
      select: { logoObjectKey: true, logoContentType: true },
    });
    if (!row?.logoObjectKey || !row.logoContentType) return undefined;
    return { objectKey: row.logoObjectKey, contentType: row.logoContentType };
  }
}
