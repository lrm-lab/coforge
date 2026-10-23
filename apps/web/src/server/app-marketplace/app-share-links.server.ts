import { AppError } from "#src/lib/app-error";
import type { ManagedApp } from "#src/server/apps/managed-app";
import type { AppPublishStatus } from "#src/features/apps/app-publish-status";
import { mintShareToken } from "#src/server/app-marketplace/app-share-link-token.server";
import {
  marketplaceOff,
  requireMarketplaceMember,
  type MarketplaceFlag,
} from "#src/server/app-marketplace/marketplace-access.server";
import type { WorkspaceMemberRole } from "#src/server/workspaces/member-role.server";

/** A share link lives this many days unless the caller asks for another (Raft's app editor makes
 * 30-day links; its Agent CLI takes 1 to 365). */
export const SHARE_LINK_TTL_DAYS = 30;
export const SHARE_LINK_MIN_DAYS = 1;
export const SHARE_LINK_MAX_DAYS = 365;

/** The member acting, in the Workspace the request names. */
export type ShareLinkActor = { workspaceId: string; actorUserId: string };

/** What is known of an app's active link; its URL is never kept. */
export type ShareLinkStatus = { createdAt: Date; expiresAt: Date };

export interface AppShareLinkStore {
  findMember(
    workspaceId: string,
    userId: string,
  ): Promise<{ role: WorkspaceMemberRole; workspaceSlug: string } | undefined>;
  /** The app `key` that `workspaceId` owns. */
  findOwned(
    workspaceId: string,
    key: string,
  ): Promise<{ appId: string; publishStatus: AppPublishStatus } | undefined>;
  /** The link that is neither revoked nor expired at `now`. */
  findActive(appId: string, now: Date): Promise<ShareLinkStatus | undefined>;
  /** Revokes the app's unrevoked link, if any, and stores the new one, in one transaction. */
  replace(input: {
    appId: string;
    tokenHash: string;
    /** None when an Agent made the link. */
    userId: string | null;
    at: Date;
    expiresAt: Date;
  }): Promise<void>;
  /** Revokes the app's unrevoked link; `false` when it had none. */
  revoke(appId: string, at: Date): Promise<boolean>;
}

/** Sharing is only offered to a private or rejected app, as in Raft's share card. */
const SHAREABLE: readonly AppPublishStatus[] = ["private", "rejected"];

/**
 * Private share links (`app-marketplace`): an owner or admin of an app's Workspace creates one,
 * and an owner or admin of another Workspace installs the app from it (`AppInstallations`). One
 * link is active at a time; creating again revokes the old one (Raft's "Regenerate"). The URL is
 * shown once, when created: only its hash is stored. Revoking stops new installs and removes none.
 * Publication changes revoke nothing, and a link neither lists the app nor needs review.
 */
export class AppShareLinks {
  constructor(
    private readonly store: AppShareLinkStore,
    private readonly enabled: MarketplaceFlag,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** When the active link expires, or `null` for none. Never the URL. */
  async status(actor: ShareLinkActor, key: string): Promise<ShareLinkStatus | null> {
    const app = await this.ownedApp(actor, key);
    return (await this.store.findActive(app.appId, this.now())) ?? null;
  }

  /** Creates the app's link, revoking the previous one; the token is returned only here. It lives
   * `expiresInDays` (a whole number from 1 to 365; 30 when absent), else INVALID_INPUT. */
  async create(
    actor: ShareLinkActor,
    key: string,
    options: { expiresInDays?: number } = {},
  ): Promise<{ token: string; expiresAt: Date; createdAt: Date }> {
    const days = checkedDays(options.expiresInDays);
    const app = await this.ownedApp(actor, key);
    return this.makeLink(app, actor.actorUserId, days);
  }

  /** `create` for an app an Agent manages: the link records no user. */
  async createManaged(managed: ManagedApp, options: { expiresInDays?: number } = {}) {
    const days = checkedDays(options.expiresInDays);
    await this.requireEnabled(managed);
    return this.makeLink(managedShareApp(managed), null, days);
  }

  private async makeLink(
    app: { appId: string; publishStatus: AppPublishStatus },
    userId: string | null,
    days: number,
  ): Promise<{ token: string; expiresAt: Date; createdAt: Date }> {
    if (!SHAREABLE.includes(app.publishStatus)) {
      throw new AppError("CONFLICT", { errorId: "app-share-status-conflict" });
    }
    const at = this.now();
    const expiresAt = new Date(at.getTime() + days * 24 * 60 * 60 * 1000);
    const { token, hash } = mintShareToken();
    await this.store.replace({ appId: app.appId, tokenHash: hash, userId, at, expiresAt });
    return { token, expiresAt, createdAt: at };
  }

  /** `status` for an app an Agent manages. */
  async statusManaged(managed: ManagedApp): Promise<ShareLinkStatus | null> {
    await this.requireEnabled(managed);
    return (await this.store.findActive(managed.app.id, this.now())) ?? null;
  }

  /** Revokes the active link, whatever the app's publish status; repeating it changes nothing. */
  async revoke(actor: ShareLinkActor, key: string): Promise<void> {
    const app = await this.ownedApp(actor, key);
    await this.store.revoke(app.appId, this.now());
  }

  /** `revoke` for an app an Agent manages. */
  async revokeManaged(managed: ManagedApp): Promise<void> {
    await this.requireEnabled(managed);
    await this.store.revoke(managed.app.id, this.now());
  }

  private async requireEnabled(workspace: { workspaceId: string; workspaceSlug: string }) {
    if (!(await this.enabled(workspace))) throw marketplaceOff();
  }

  /** The actor manages apps, the Marketplace is on for their Workspace, and `key` is its own app. */
  private async ownedApp(actor: ShareLinkActor, key: string) {
    await requireMarketplaceMember(this.store, this.enabled, actor, { manage: true });
    const app = await this.store.findOwned(actor.workspaceId, key);
    if (!app) throw new AppError("NOT_FOUND");
    return app;
  }
}

function checkedDays(days = SHARE_LINK_TTL_DAYS): number {
  if (!Number.isInteger(days) || days < SHARE_LINK_MIN_DAYS || days > SHARE_LINK_MAX_DAYS)
    throw new AppError("INVALID_INPUT", { errorId: "app-share-expiry-invalid" });
  return days;
}

const managedShareApp = ({ app }: ManagedApp) => ({
  appId: app.id,
  publishStatus: app.publishStatus,
});
