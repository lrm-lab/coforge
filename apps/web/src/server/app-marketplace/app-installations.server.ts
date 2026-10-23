import { AppError } from "#src/lib/app-error";
import { APP_PERMISSIONS_CHANGED } from "#src/features/apps/app-permissions";
import type { AppCategory } from "#src/features/apps/app-category";
import type { AppActor } from "#src/server/apps/app-registry.server";
import type { AppPermissions } from "#src/server/app-permissions/app-permissions.server";
import {
  assertCanManageApps,
  type WorkspaceMemberRole,
} from "#src/server/workspaces/member-role.server";

/** A published app as another Workspace sees it in the Marketplace. */
export type MarketplaceListing = {
  appId: string;
  key: string;
  name: string;
  description: string;
  category: AppCategory;
  homepageUrl: string | null;
  /** The URLs the app signs people back in at; surfaces show their domains. */
  redirectUris: string[];
  allowedScopes: string[];
  permissionGroups: string[];
  notificationEvents: string[];
  /** The declaration an install approves, so an install can name the one it was shown. */
  permissionRevision: number;
  ownerWorkspaceId: string;
  /** The name of the Workspace that registered the app: the developer. */
  developer: string;
  logoObjectKey: string | null;
  publishedAt: Date | null;
  /** In how many Workspaces the app is installed, its own included. */
  installCount: number;
  /** Whether the asking Workspace has installed it. */
  installed: boolean;
};

export interface AppInstallationStore {
  findMember(
    workspaceId: string,
    userId: string,
  ): Promise<{ role: WorkspaceMemberRole; workspaceSlug: string } | undefined>;
  /** The listed apps that `workspaceId` does not own. */
  listListings(workspaceId: string): Promise<MarketplaceListing[]>;
  /** One of them; `undefined` for a private, requested, rejected or own app, or no such key. */
  findListing(
    workspaceId: string,
    key: string,
    options?: { lock?: boolean },
  ): Promise<MarketplaceListing | undefined>;
  /** Installs the app; `false` when the Workspace already has it. */
  install(input: { appId: string; workspaceId: string; userId: string }): Promise<boolean>;
  /** The app `key` installed in `workspaceId` that another Workspace owns. */
  findInstalledElsewhere(workspaceId: string, key: string): Promise<{ appId: string } | undefined>;
  /** Removes the installation and revokes what it had granted. */
  uninstall(input: {
    appId: string;
    workspaceId: string;
    userId: string;
    at: Date;
  }): Promise<boolean>;
}

/** What an install and an uninstall run on: one transaction over the store and the permissions
 * module, so an install and its approval stand or fall together. */
export type InstallationScope = {
  store: AppInstallationStore;
  permissions: Pick<AppPermissions, "approve">;
};

export type InstallationFlag = (workspace: {
  workspaceId: string;
  workspaceSlug: string;
}) => Promise<boolean>;

const OFF = () => new AppError("ACCESS_DENIED", { errorId: "app-marketplace-off" });

/**
 * Discovering published apps of other Workspaces and installing them, behind `app-marketplace`
 * for the Workspace the request comes from. Every member browses; owners and admins (who manage
 * apps) install and uninstall. An install creates the same `app_installations` row registering
 * does, and, where `app-data-permissions` is on, approves the declaration the installer was shown
 * (Raft: "Install records exactly these"), through the same approval an installed app's update
 * takes; a declaration changed meanwhile is CONFLICT (`app-permissions-changed`) and nothing is
 * installed. Agent access starts as All Agents (the column default). An app another Workspace
 * cannot see (private, requested, rejected, or its own) is NOT_FOUND.
 */
export class AppInstallations {
  constructor(
    private readonly transaction: <Result>(
      work: (scope: InstallationScope) => Promise<Result>,
    ) => Promise<Result>,
    private readonly marketplaceOn: InstallationFlag,
    private readonly permissionsOn: InstallationFlag,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** What opening the Marketplace shows, read in one transaction after one member and flag check:
   * the apps other Workspaces published with whether this one has installed each, and whether an
   * install approves the shown declaration here (`app-data-permissions` is on), so a surface says
   * "approves exactly these" only where it is true. */
  async browse(
    actor: AppActor,
  ): Promise<{ listings: MarketplaceListing[]; approvesOnInstall: boolean }> {
    return this.transaction(async ({ store }) => {
      const workspace = await this.access(store, actor, { manage: false });
      return {
        listings: await store.listListings(actor.workspaceId),
        approvesOnInstall: await this.permissionsOn(workspace),
      };
    });
  }

  /** Installs the listed app `key` in the actor's Workspace. `revision` is the declaration
   * shown, approved with the install where `app-data-permissions` is on. Installing an app the
   * Workspace already has changes nothing. */
  async install(actor: AppActor, key: string, revision: number): Promise<void> {
    await this.transaction(async ({ store, permissions }) => {
      const workspace = await this.access(store, actor, { manage: true });
      // Locks the app row until the transaction ends, so an offline approval cannot run between
      // this check and the installation row: it waits, then removes the row this wrote.
      const listing = await store.findListing(actor.workspaceId, key, { lock: true });
      if (!listing) throw new AppError("NOT_FOUND");
      if (listing.installed) return;
      const approving = await this.permissionsOn(workspace);
      if (approving && listing.permissionRevision !== revision) {
        throw new AppError("CONFLICT", { errorId: APP_PERMISSIONS_CHANGED });
      }
      const created = await store.install({
        appId: listing.appId,
        workspaceId: actor.workspaceId,
        userId: actor.actorUserId,
      });
      if (created && approving) await permissions.approve(actor, key, revision);
    });
  }

  /** Removes the app another Workspace owns from the actor's Workspace and revokes its grants
   * and tokens there. NOT_FOUND when it is not installed here, or is the Workspace's own. */
  async uninstall(actor: AppActor, key: string): Promise<void> {
    await this.transaction(async ({ store }) => {
      await this.access(store, actor, { manage: true });
      const installed = await store.findInstalledElsewhere(actor.workspaceId, key);
      if (!installed) throw new AppError("NOT_FOUND");
      await store.uninstall({
        appId: installed.appId,
        workspaceId: actor.workspaceId,
        userId: actor.actorUserId,
        at: this.now(),
      });
    });
  }

  /** The actor is a member (ACCESS_DENIED otherwise), may manage apps when `manage`, and the
   * Marketplace is on in their Workspace (the off refusal otherwise). */
  private async access(
    store: AppInstallationStore,
    actor: AppActor,
    { manage }: { manage: boolean },
  ) {
    const member = await store.findMember(actor.workspaceId, actor.actorUserId);
    if (!member) throw new AppError("ACCESS_DENIED");
    if (manage) assertCanManageApps(member.role);
    const workspace = { workspaceId: actor.workspaceId, workspaceSlug: member.workspaceSlug };
    if (!(await this.marketplaceOn(workspace))) throw OFF();
    return workspace;
  }
}
