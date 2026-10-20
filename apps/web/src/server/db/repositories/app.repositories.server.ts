import { hasErrorCode } from "@lrm/coforge-sdk/internal";
import type { PrismaClient } from "#src/generated/prisma/client";
import type { AppRegistrationInput } from "#src/features/apps/app-registration";
import type { AppChange, AppRegistryStore } from "#src/server/apps/app-registry.server";
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
  resourceUri: true,
  allowedScopes: true,
  secretRotatedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

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
    return this.db.app.findMany({
      where: { installations: { some: { workspaceId } } },
      select: APP_VIEW,
      orderBy: [{ name: "asc" }, { key: "asc" }],
    });
  }

  async find(key: string) {
    return (await this.db.app.findUnique({ where: { key }, select: APP_VIEW })) ?? undefined;
  }

  async findSecretHash(key: string) {
    const row = await this.db.app.findUnique({
      where: { key },
      select: { clientSecretHash: true },
    });
    return row?.clientSecretHash ?? undefined;
  }

  async create(input: {
    app: AppRegistrationInput;
    workspaceId: string;
    userId: string;
    clientSecretHash: string;
  }) {
    try {
      return await this.db.app.create({
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
    } catch (error) {
      if (isUniqueViolation(error)) return undefined;
      throw error;
    }
  }

  async update(workspaceId: string, key: string, change: AppChange) {
    try {
      return await this.db.app.update({
        where: owned(workspaceId, key),
        data: change,
        select: APP_VIEW,
      });
    } catch (error) {
      // P2025: no such app of this Workspace.
      if (hasErrorCode(error, "P2025")) return undefined;
      throw error;
    }
  }

  async delete(workspaceId: string, key: string) {
    try {
      await this.db.app.delete({ where: owned(workspaceId, key), select: { id: true } });
      return true;
    } catch (error) {
      if (hasErrorCode(error, "P2025")) return false;
      throw error;
    }
  }
}
