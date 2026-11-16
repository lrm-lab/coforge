import type { PrismaClient } from "#src/generated/prisma/client";
import { isDatabaseClient, type DatabaseScope } from "#src/server/db/transaction.server";
import { WorkspaceAssistants } from "#src/server/agents/workspace-assistants.server";
import { AppError } from "#src/lib/app-error";
import type { Locale } from "#src/paraglide/runtime";
import { WorkspaceCatalog, PrismaWorkspaceCatalogStore } from "./catalog.server";
import { isUniqueViolation } from "#src/server/db/unique-violation.server";
import { createOwnedWorkspace } from "#src/server/db/repositories/workspace-slugs.repositories.server";
import {
  isReservedWorkspaceSlug,
  isValidWorkspaceSlug,
  nameToWorkspaceSlug,
} from "#src/features/workspaces/workspace-slug";
export type EnrollmentUser = {
  id: string;
  username: string;
  displayName: string;
};
export type WorkspaceEnrollmentStore = {
  findMembership(userId: string): Promise<string | null>;
  createForUser(input: {
    slug: string;
    name: string;
    userId: string;
    locale: Locale;
  }): Promise<string>;
};
export class WorkspaceEnrollment {
  constructor(private readonly store: WorkspaceEnrollmentStore) {}
  async ensureForUser(
    user: EnrollmentUser,
    locale: Locale,
    slug?: string,
  ): Promise<{
    workspaceId: string;
    created: boolean;
  }> {
    const existing = await this.store.findMembership(user.id);
    if (existing) return { workspaceId: existing, created: false };
    const name = workspaceDisplayName(user.displayName, locale);
    return slug
      ? this.create({ slug, name, userId: user.id, locale })
      : this.createOwnedWorkspace(user.username, user.id, name, locale);
  }
  private async createOwnedWorkspace(
    username: string,
    userId: string,
    name: string,
    locale: Locale,
  ): Promise<{
    workspaceId: string;
    created: boolean;
  }> {
    const slug = nameToWorkspaceSlug(username);
    if (isValidWorkspaceSlug(slug) && !isReservedWorkspaceSlug(slug)) {
      try {
        return await this.create({ slug, name, userId, locale });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
    const suffix = userId.replaceAll("-", "").slice(0, 8);
    return this.create({ slug: `${slug}-${suffix}`, name, userId, locale });
  }
  private async create(input: {
    slug: string;
    name: string;
    userId: string;
    locale: Locale;
  }): Promise<{
    workspaceId: string;
    created: boolean;
  }> {
    try {
      return { workspaceId: await this.store.createForUser(input), created: true };
    } catch (error) {
      if (isUniqueViolation(error)) {
        const concurrent = await this.store.findMembership(input.userId);
        if (concurrent) return { workspaceId: concurrent, created: false };
      }
      throw error;
    }
  }
}
function workspaceDisplayName(displayName: string, locale: Locale): string {
  const name = displayName.trim() || "User";
  return locale === "zh-CN" ? `${name}的工作区` : `${name}'s Workspace`;
}
export class PrismaWorkspaceEnrollmentStore implements WorkspaceEnrollmentStore {
  constructor(private readonly db: DatabaseScope) {}
  async findMembership(userId: string) {
    const row = await this.db.workspaceMembership.findFirst({
      where: { userId },
      select: { workspaceId: true },
      orderBy: [{ workspace: { createdAt: "asc" } }, { workspaceId: "asc" }],
    });
    return row?.workspaceId ?? null;
  }
  async createForUser(input: { slug: string; name: string; userId: string; locale: Locale }) {
    const row = await createOwnedWorkspace(this.db, input, { id: true });
    if (isDatabaseClient(this.db))
      await provisionWorkspaceEnrollment(this.db, row.id, input.userId, {
        locale: input.locale,
      });
    return row.id;
  }
}
export async function provisionWorkspaceEnrollment(
  db: PrismaClient,
  workspaceId: string,
  userId: string,
  options: {
    locale?: Locale;
  } = {},
) {
  await new WorkspaceAssistants(db).ensure(workspaceId, userId, options);
}
export async function requireExistingWorkspaceId(
  db: PrismaClient,
  userId: string,
  preferredSlug?: string,
): Promise<string> {
  const selected = await new WorkspaceCatalog(new PrismaWorkspaceCatalogStore(db)).selectForUser(
    userId,
    preferredSlug,
  );
  if (!selected) throw new AppError("WORKSPACE_REQUIRED");
  return selected.id;
}
export function workspaceIdForUser(
  db: PrismaClient,
  user: EnrollmentUser,
  locale: Locale,
): Promise<string> {
  return new WorkspaceEnrollment(new PrismaWorkspaceEnrollmentStore(db))
    .ensureForUser(user, locale)
    .then((result) => result.workspaceId);
}
