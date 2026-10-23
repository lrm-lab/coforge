import { AppError } from "#src/lib/app-error";
import type { AppPublishStatus } from "#src/features/apps/app-publish-status";
import { mintShareToken } from "#src/server/app-marketplace/app-share-link-token.server";
import {
  requireMarketplaceMember,
  type MarketplaceFlag,
} from "#src/server/app-marketplace/marketplace-access.server";
import type { WorkspaceMemberRole } from "#src/server/workspaces/member-role.server";

/** A share link lives this many days (Raft's app editor makes 30-day links). */
export const SHARE_LINK_TTL_DAYS = 30;

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
    userId: string;
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

  /** Creates the app's link, revoking the previous one; the token is returned only here. */
  async create(
    actor: ShareLinkActor,
    key: string,
  ): Promise<{ token: string; expiresAt: Date; createdAt: Date }> {
    const app = await this.ownedApp(actor, key);
    if (!SHAREABLE.includes(app.publishStatus)) {
      throw new AppError("CONFLICT", { errorId: "app-share-status-conflict" });
    }
    const at = this.now();
    const expiresAt = new Date(at.getTime() + SHARE_LINK_TTL_DAYS * 24 * 60 * 60 * 1000);
    const { token, hash } = mintShareToken();
    await this.store.replace({
      appId: app.appId,
      tokenHash: hash,
      userId: actor.actorUserId,
      at,
      expiresAt,
    });
    return { token, expiresAt, createdAt: at };
  }

  /** Revokes the active link, whatever the app's publish status; repeating it changes nothing. */
  async revoke(actor: ShareLinkActor, key: string): Promise<void> {
    const app = await this.ownedApp(actor, key);
    await this.store.revoke(app.appId, this.now());
  }

  /** The actor manages apps, the Marketplace is on for their Workspace, and `key` is its own app. */
  private async ownedApp(actor: ShareLinkActor, key: string) {
    await requireMarketplaceMember(this.store, this.enabled, actor, { manage: true });
    const app = await this.store.findOwned(actor.workspaceId, key);
    if (!app) throw new AppError("NOT_FOUND");
    return app;
  }
}
