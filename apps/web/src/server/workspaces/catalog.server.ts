import type { PrismaClient } from "#src/generated/prisma/client";
import {
  appNotificationsPossible,
  attemptAppNotification,
} from "#src/server/app-notifications/app-notifications.server";
import { recordWorkspaceConfigUpdated } from "#src/server/app-notifications/workspace-events.server";
import { WorkspaceAssistants } from "#src/server/agents/workspace-assistants.server";
import { AppError } from "#src/lib/app-error";
import { attachDefaultMemoryAgentToGeneral } from "#src/server/workspace-memory/default-memory-agent.server";
import {
  isReservedWorkspaceSlug,
  isValidWorkspaceSlug,
} from "#src/features/workspaces/workspace-slug";
import { WORKSPACE_NAME_MAX_LENGTH } from "#src/features/workspaces/workspace.schemas";
import { isUniqueViolation } from "#src/server/db/unique-violation.server";
import { assertCanManageWorkspaceSettings } from "#src/server/workspaces/member-role.server";
import { canChangeWorkspaceSlug } from "#src/features/workspaces/workspace-roles";
import { workspaceIconUrl } from "#src/server/workspaces/workspace-images.server";
import {
  createOwnedWorkspace,
  moveWorkspaceSlug,
} from "#src/server/db/repositories/workspace-slugs.repositories.server";

export type WorkspaceRecord = { id: string; slug: string; name: string; iconUrl: string | null };
/** A Workspace the User belongs to, with their role in it. */
export type MemberWorkspaceRecord = WorkspaceRecord & { role: string };

export type WorkspaceCatalogStore = {
  listForUser(userId: string): Promise<MemberWorkspaceRecord[]>;
  createForUser(input: { slug: string; name: string; userId: string }): Promise<WorkspaceRecord>;
  rename(workspaceId: string, name: string): Promise<WorkspaceRecord>;
  /** Moves the Workspace to `slug` and keeps its current slug as a former one, which goes on
   * naming it. Throws a unique violation when another Workspace has or had `slug`. */
  changeSlug(workspaceId: string, slug: string): Promise<WorkspaceRecord>;
};

/** The preferred Workspace when the User belongs to it, otherwise their first one. */
export function pickWorkspace<T extends { slug: string }>(
  workspaces: readonly T[],
  preferredSlug?: string,
): T | null {
  if (preferredSlug) {
    const preferred = workspaces.find((workspace) => workspace.slug === preferredSlug);
    if (preferred) return preferred;
  }
  return workspaces[0] ?? null;
}

/** The trimmed slug when a Workspace may have it; INVALID_INPUT for a malformed or reserved one. */
function acceptableSlug(slug: string): string {
  const trimmed = slug.trim();
  if (!isValidWorkspaceSlug(trimmed) || isReservedWorkspaceSlug(trimmed))
    throw new AppError("INVALID_INPUT");
  return trimmed;
}

export class WorkspaceCatalog {
  constructor(private readonly store: WorkspaceCatalogStore) {}

  listForUser(userId: string): Promise<MemberWorkspaceRecord[]> {
    return this.store.listForUser(userId);
  }

  async selectForUser(
    userId: string,
    preferredSlug?: string,
  ): Promise<MemberWorkspaceRecord | null> {
    return pickWorkspace(await this.store.listForUser(userId), preferredSlug);
  }

  async createForUser(
    userId: string,
    input: { name: string; slug: string },
  ): Promise<WorkspaceRecord> {
    const name = input.name.trim();
    if (!name) throw new AppError("INVALID_INPUT");
    const slug = acceptableSlug(input.slug);
    try {
      return await this.store.createForUser({ slug, name, userId });
    } catch (error) {
      if (isUniqueViolation(error)) throw new AppError("CONFLICT");
      throw new Error("workspace creation failed");
    }
  }

  /** Renames the Workspace; its owner or an admin only. The slug, and so every URL, stays. */
  async rename(
    workspaceId: string,
    actorRole: string | undefined,
    name: string,
  ): Promise<WorkspaceRecord> {
    assertCanManageWorkspaceSettings(actorRole);
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > WORKSPACE_NAME_MAX_LENGTH) throw new AppError("INVALID_INPUT");
    return this.store.rename(workspaceId, trimmed);
  }

  /**
   * Changes the Workspace's URL; its owner only. The old slug stays this Workspace's for good, so
   * links and Computers that name it keep reaching it, and no other Workspace can ever take it.
   */
  async changeSlug(
    workspaceId: string,
    actorRole: string | undefined,
    slug: string,
  ): Promise<WorkspaceRecord> {
    if (!canChangeWorkspaceSlug(actorRole)) throw new AppError("ACCESS_DENIED");
    const trimmed = acceptableSlug(slug);
    try {
      return await this.store.changeSlug(workspaceId, trimmed);
    } catch (error) {
      if (isUniqueViolation(error)) throw new AppError("CONFLICT");
      throw error;
    }
  }
}

const workspaceSelect = { id: true, slug: true, name: true, iconObjectKey: true } as const;

function workspaceRecord(row: {
  id: string;
  slug: string;
  name: string;
  iconObjectKey: string | null;
}): WorkspaceRecord {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    iconUrl: workspaceIconUrl(row.id, row.iconObjectKey),
  };
}

export class PrismaWorkspaceCatalogStore implements WorkspaceCatalogStore {
  constructor(private readonly db: PrismaClient) {}

  async listForUser(userId: string) {
    const memberships = await this.db.workspaceMembership.findMany({
      where: { userId },
      select: { role: true, workspace: { select: workspaceSelect } },
      orderBy: { workspace: { createdAt: "asc" } },
    });
    return memberships.map(({ role, workspace }) => ({ ...workspaceRecord(workspace), role }));
  }

  async createForUser(input: { slug: string; name: string; userId: string }) {
    const row = await createOwnedWorkspace(this.db, input, workspaceSelect);
    await attachDefaultMemoryAgentToGeneral(this.db, row.id, input.userId);
    await new WorkspaceAssistants(this.db).ensure(row.id, input.userId);
    return workspaceRecord(row);
  }

  async rename(workspaceId: string, name: string) {
    const where = { id: workspaceId };
    if (!appNotificationsPossible())
      return workspaceRecord(
        await this.db.workspace.update({ where, data: { name }, select: workspaceSelect }),
      );
    return this.db.$transaction(async (tx) => {
      const previous = await attemptAppNotification(tx, () =>
        tx.workspace.findUnique({ where, select: { name: true } }),
      );
      const row = await tx.workspace.update({ where, data: { name }, select: workspaceSelect });
      if (previous && previous.name !== name) await recordWorkspaceConfigUpdated(tx, row, { name });
      return workspaceRecord(row);
    });
  }

  async changeSlug(workspaceId: string, slug: string) {
    return workspaceRecord(await moveWorkspaceSlug(this.db, workspaceId, slug, workspaceSelect));
  }
}
