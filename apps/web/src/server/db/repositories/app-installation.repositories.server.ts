import type { Prisma } from "#src/generated/prisma/client";
import type { AppCategory } from "#src/features/apps/app-category";
import { LISTED_STATUSES } from "#src/features/apps/app-publish-status";
import type {
  AppInstallationStore,
  MarketplaceListing,
  SharedAppInfo,
} from "#src/server/app-marketplace/app-installations.server";
import { revokeAppAgentAccess } from "#src/server/db/repositories/app-agent-access.repositories.server";
import { revokeAppAuthorizations } from "#src/server/db/repositories/oauth-authorization.repositories.server";
import { WORKSPACE_CAPABILITY_ROLES } from "#src/features/workspaces/workspace-roles";
import { findAppMember } from "#src/server/db/repositories/app.repositories.server";

/**
 * The one owner of what removing an installation revokes. Takes an app away from the Workspaces
 * `workspace` names and ends everything they had granted. EVERY table keyed by (appId,
 * workspaceId) must be covered here, each through the module that owns it:
 * - `user_app_consents` and `oauth_authorization_codes`: `revokeAppAuthorizations`
 *   (oauth-authorization repository);
 * - `app_agent_grants` and `app_agent_access_requests`: `revokeAppAgentAccess`
 *   (app-agent-access repository);
 * - `app_installations`: deleted last; installation tokens and Login with CoForge sessions are
 *   checked against it.
 * A new such table adds its revocation to its owner and a call here. `userId` is the person who
 * caused it.
 */
export async function removeAppInstallations(
  tx: Prisma.TransactionClient,
  input: {
    appId: string;
    workspace: string | { not: string };
    userId: string;
    at: Date;
  },
): Promise<number> {
  const { appId, workspace, userId, at } = input;
  await revokeAppAuthorizations(tx, { appId, workspace, at });
  await revokeAppAgentAccess(tx, { appId, workspace, userId, at });
  const { count } = await tx.appInstallation.deleteMany({
    where: { appId, workspaceId: workspace },
  });
  return count;
}

const LISTING = {
  id: true,
  key: true,
  name: true,
  description: true,
  category: true,
  homepageUrl: true,
  redirectUris: true,
  allowedScopes: true,
  permissionGroups: true,
  notificationEvents: true,
  permissionRevision: true,
  ownerWorkspaceId: true,
  logoObjectKey: true,
  publishedAt: true,
  ownerWorkspace: { select: { name: true } },
  _count: { select: { installations: true } },
} as const;

/** Apps other Workspaces can install: listed (`LISTED_STATUSES`) and not owned by `workspaceId`. */
const listedElsewhere = (workspaceId: string) => ({
  publishStatus: { in: [...LISTED_STATUSES] },
  ownerWorkspaceId: { not: workspaceId },
});

/** A share link that is neither revoked nor expired at `now`. */
const live = (tokenHash: string, now: Date) => ({
  tokenHash,
  revokedAt: null,
  expiresAt: { gt: now },
});

/** Marketplace listings and the installation rows an install and an uninstall write. Who may do
 * either stays in `server/app-marketplace/`. */
export class PrismaAppInstallationStore implements AppInstallationStore {
  constructor(private readonly db: Prisma.TransactionClient) {}

  findMember(workspaceId: string, userId: string) {
    return findAppMember(this.db, workspaceId, userId);
  }

  async listListings(workspaceId: string) {
    const rows = await this.db.app.findMany({
      where: listedElsewhere(workspaceId),
      select: {
        ...LISTING,
        installations: { where: { workspaceId }, select: { id: true } },
      },
      orderBy: [{ name: "asc" }, { key: "asc" }],
    });
    return rows.map((row) => listing(row, row.installations.length > 0));
  }

  async findListing(workspaceId: string, key: string, { lock = false } = {}) {
    // `FOR SHARE` on the app row lets installs run in parallel yet serializes with the offline
    // approval, which takes `FOR UPDATE` on the same row; the read below then sees the status
    // that approval left.
    if (lock) await this.db.$queryRaw`SELECT id FROM apps WHERE key = ${key} FOR SHARE`;
    const row = await this.db.app.findFirst({
      where: { key, ...listedElsewhere(workspaceId) },
      select: { ...LISTING, installations: { where: { workspaceId }, select: { id: true } } },
    });
    return row ? listing(row, row.installations.length > 0) : undefined;
  }

  async findLiveShare(tokenHash: string, now: Date) {
    const link = await this.db.appShareLink.findFirst({
      where: live(tokenHash, now),
      select: {
        expiresAt: true,
        app: { select: { ...LISTING, logoContentType: true } },
      },
    });
    if (!link) return undefined;
    const { logoContentType, ...row } = link.app;
    return {
      app: info(row),
      expiresAt: link.expiresAt,
      logo:
        row.logoObjectKey && logoContentType
          ? { objectKey: row.logoObjectKey, contentType: logoContentType }
          : null,
    };
  }

  async installedIn(appId: string, workspaceIds: string[]) {
    const rows = await this.db.appInstallation.findMany({
      where: { appId, workspaceId: { in: workspaceIds } },
      select: { workspaceId: true },
    });
    return rows.map((row) => row.workspaceId);
  }

  async listManagerMemberships(userId: string) {
    const rows = await this.db.workspaceMembership.findMany({
      where: { userId, role: { in: [...WORKSPACE_CAPABILITY_ROLES.manageApps] } },
      select: { workspace: { select: { id: true, slug: true, name: true } } },
      orderBy: [{ workspace: { name: "asc" } }, { workspace: { slug: "asc" } }],
    });
    return rows.map(({ workspace }) => ({
      workspaceId: workspace.id,
      slug: workspace.slug,
      name: workspace.name,
    }));
  }

  async install(input: { appId: string; workspaceId: string; userId: string }) {
    const { count } = await this.db.appInstallation.createMany({
      data: [
        { appId: input.appId, workspaceId: input.workspaceId, installedByUserId: input.userId },
      ],
      skipDuplicates: true,
    });
    return count === 1;
  }

  async findInstalledElsewhere(workspaceId: string, key: string) {
    const row = await this.db.app.findFirst({
      where: {
        key,
        ownerWorkspaceId: { not: workspaceId },
        installations: { some: { workspaceId } },
      },
      select: { id: true },
    });
    return row ? { appId: row.id } : undefined;
  }

  uninstall(input: { appId: string; workspaceId: string; userId: string; at: Date }) {
    return removeAppInstallations(this.db, {
      appId: input.appId,
      workspace: input.workspaceId,
      userId: input.userId,
      at: input.at,
    }).then((count) => count > 0);
  }
}

type ListingRow = {
  id: string;
  key: string;
  name: string;
  description: string;
  category: string;
  homepageUrl: string | null;
  redirectUris: string[];
  allowedScopes: string[];
  permissionGroups: string[];
  notificationEvents: string[];
  permissionRevision: number;
  ownerWorkspaceId: string;
  logoObjectKey: string | null;
  publishedAt: Date | null;
  ownerWorkspace: { name: string };
  _count: { installations: number };
};

/** A row as the app a Workspace sees, before it is said whether that Workspace has installed it. */
function info(row: ListingRow): SharedAppInfo {
  const { ownerWorkspace, _count, category, id, ...app } = row;
  return {
    ...app,
    appId: id,
    category: category as AppCategory,
    developer: ownerWorkspace.name,
    installCount: _count.installations,
  };
}

function listing(row: ListingRow, installed: boolean): MarketplaceListing {
  return { ...info(row), installed };
}
