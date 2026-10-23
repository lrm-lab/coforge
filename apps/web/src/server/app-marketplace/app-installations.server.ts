import { AppError } from "#src/lib/app-error";
import { APP_PERMISSIONS_CHANGED } from "#src/features/apps/app-permissions";
import type { AppCategory } from "#src/features/apps/app-category";
import type { AppActor } from "#src/server/apps/app-registry.server";
import type { AppPermissions } from "#src/server/app-permissions/app-permissions.server";
import { hashShareToken } from "#src/server/app-marketplace/app-share-link-token.server";
import {
  requireMarketplaceMember,
  type MarketplaceFlag,
} from "#src/server/app-marketplace/marketplace-access.server";
import type { WorkspaceMemberRole } from "#src/server/workspaces/member-role.server";

/** An app as another Workspace sees it, before it is said whether that Workspace has it. */
export type SharedAppInfo = {
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
};

/** A published app as another Workspace sees it in the Marketplace. */
export type MarketplaceListing = SharedAppInfo & {
  /** Whether the asking Workspace has installed it. */
  installed: boolean;
};

/** A Workspace a person could install a shared app in: one where they own or administer. */
export type SharedInstallTarget = {
  workspaceId: string;
  slug: string;
  name: string;
  /** The Workspace already has the app (the owner's own Workspace always does). */
  installed: boolean;
  /** An install approves exactly the declarations shown (`app-data-permissions` is on there). */
  approvesOnInstall: boolean;
};

/** What a private share link opens to: the app, whose it is, when the link ends, and where the
 * person may install it. */
export type SharedAppPreview = {
  app: SharedAppInfo;
  expiresAt: Date;
  targets: SharedInstallTarget[];
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
  /** The app a live share link names, whatever its publish status, with when the link ends and
   * its logo object; `undefined` for an unknown, revoked or expired link. */
  findLiveShare(
    tokenHash: string,
    now: Date,
  ): Promise<
    | {
        app: SharedAppInfo;
        expiresAt: Date;
        logo: { objectKey: string; contentType: string } | null;
      }
    | undefined
  >;
  /** Which of `workspaceIds` have `appId` installed. */
  installedIn(appId: string, workspaceIds: string[]): Promise<string[]>;
  /** The Workspaces where the person holds the app-managing role, by name. */
  listManagerMemberships(
    userId: string,
  ): Promise<{ workspaceId: string; slug: string; name: string }[]>;
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

export type InstallationFlag = MarketplaceFlag;

/**
 * Discovering published apps of other Workspaces and installing them, behind `app-marketplace`
 * for the Workspace the request comes from. Every member browses; owners and admins (who manage
 * apps) install and uninstall. An install creates the same `app_installations` row registering
 * does, and, where `app-data-permissions` is on, approves the declaration the installer was shown
 * (Raft: "Install records exactly these"), through the same approval an installed app's update
 * takes; a declaration changed meanwhile is CONFLICT (`app-permissions-changed`) and nothing is
 * installed. Agent access starts as All Agents (the column default). An app another Workspace
 * cannot see (private, requested, rejected, or its own) is NOT_FOUND, unless it holds a live
 * private share link (`previewShared`, `installShared`), which installs the same way.
 */
export class AppInstallations {
  constructor(
    private readonly transaction: <Result>(
      work: (scope: InstallationScope) => Promise<Result>,
    ) => Promise<Result>,
    /** Single reads that need no transaction. */
    private readonly reads: AppInstallationStore,
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
      const workspace = await requireMarketplaceMember(store, this.marketplaceOn, actor, {
        manage: false,
      });
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
      const workspace = await requireMarketplaceMember(store, this.marketplaceOn, actor, {
        manage: true,
      });
      // Locks the app row until the transaction ends, so an offline approval cannot run between
      // this check and the installation row: it waits, then removes the row this wrote.
      const listing = await store.findListing(actor.workspaceId, key, { lock: true });
      if (!listing) throw new AppError("NOT_FOUND");
      await this.installListing(
        { store, permissions },
        actor,
        workspace,
        listing,
        listing.installed,
        revision,
      );
    });
  }

  /** What a private share link shows a signed-in person: the app and the Workspaces they may
   * install it in (where they own or administer and the Marketplace is on). NOT_FOUND for a link
   * that is unknown, revoked or expired. */
  async previewShared(userId: string, token: string): Promise<SharedAppPreview> {
    const shared = await this.reads.findLiveShare(hashShareToken(token), this.now());
    if (!shared) throw new AppError("NOT_FOUND");
    const memberships = await this.reads.listManagerMemberships(userId);
    const installed = new Set(
      await this.reads.installedIn(
        shared.app.appId,
        memberships.map((membership) => membership.workspaceId),
      ),
    );
    const offered = await Promise.all(
      memberships.map(async (membership) => {
        const workspace = { workspaceId: membership.workspaceId, workspaceSlug: membership.slug };
        const [marketplace, approvesOnInstall] = await Promise.all([
          this.marketplaceOn(workspace),
          this.permissionsOn(workspace),
        ]);
        return marketplace
          ? [{ ...membership, installed: installed.has(membership.workspaceId), approvesOnInstall }]
          : [];
      }),
    );
    return { app: shared.app, expiresAt: shared.expiresAt, targets: offered.flat() };
  }

  /** Installs, in the actor's Workspace, the app a live share link names, the way a Marketplace
   * install does (the same approval, the same CONFLICT for a declaration that moved on). The
   * link is not used up. A dead link is NOT_FOUND, and so is the app's own Workspace: it already
   * has the app and cannot install it from a link. */
  async installShared(actor: AppActor, token: string, revision: number): Promise<void> {
    await this.transaction(async ({ store, permissions }) => {
      const workspace = await requireMarketplaceMember(store, this.marketplaceOn, actor, {
        manage: true,
      });
      const shared = await store.findLiveShare(hashShareToken(token), this.now());
      if (!shared || shared.app.ownerWorkspaceId === actor.workspaceId) {
        throw new AppError("NOT_FOUND");
      }
      const installed = (await store.installedIn(shared.app.appId, [actor.workspaceId])).length > 0;
      await this.installListing(
        { store, permissions },
        actor,
        workspace,
        shared.app,
        installed,
        revision,
      );
    });
  }

  /** The logo of the app a live share link names, for the share page: the link is the
   * authorization, so a revoked or expired one is NOT_FOUND at once. */
  async sharedLogo(token: string): Promise<{ objectKey: string; contentType: string }> {
    const shared = await this.reads.findLiveShare(hashShareToken(token), this.now());
    if (!shared?.logo) throw new AppError("NOT_FOUND");
    return shared.logo;
  }

  private async installListing(
    { store, permissions }: InstallationScope,
    actor: AppActor,
    workspace: { workspaceId: string; workspaceSlug: string },
    app: Pick<SharedAppInfo, "appId" | "key" | "permissionRevision">,
    alreadyInstalled: boolean,
    revision: number,
  ): Promise<void> {
    if (alreadyInstalled) return;
    const approving = await this.permissionsOn(workspace);
    if (approving && app.permissionRevision !== revision) {
      throw new AppError("CONFLICT", { errorId: APP_PERMISSIONS_CHANGED });
    }
    const created = await store.install({
      appId: app.appId,
      workspaceId: actor.workspaceId,
      userId: actor.actorUserId,
    });
    if (created && approving) await permissions.approve(actor, app.key, revision);
  }

  /** Removes the app another Workspace owns from the actor's Workspace and revokes its grants
   * and tokens there. NOT_FOUND when it is not installed here, or is the Workspace's own. */
  async uninstall(actor: AppActor, key: string): Promise<void> {
    await this.transaction(async ({ store }) => {
      await requireMarketplaceMember(store, this.marketplaceOn, actor, { manage: true });
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
}
