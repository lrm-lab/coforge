import { AppError } from "#src/lib/app-error";
import type { ManagedApp } from "#src/server/apps/managed-app";
import {
  PUBLISH_TRANSITIONS,
  REVIEW_REASON_MAX_LENGTH,
  type AppPublishStatus,
  type AppReviewKind,
  type AppReviewOutcome,
} from "#src/features/apps/app-publish-status";
import type { AppCategory } from "#src/features/apps/app-category";
import { requireMarketplaceMember } from "#src/server/app-marketplace/marketplace-access.server";
import type { WorkspaceMemberRole } from "#src/server/workspaces/member-role.server";

/** The member acting, in the Workspace the request names. */
export type PublishingActor = { workspaceId: string; actorUserId: string };

/** A request waiting for a reviewer, with what the reviewer judges it by. */
export type PendingReview = {
  requestId: string;
  kind: AppReviewKind;
  requestedAt: Date;
  app: {
    key: string;
    name: string;
    description: string;
    category: AppCategory;
    homepageUrl: string | null;
    allowedScopes: string[];
    permissionGroups: string[];
    notificationEvents: string[];
    ownerWorkspaceId: string;
    logoObjectKey: string | null;
  };
  /** The Workspace that registered the app (its publisher). */
  publisherWorkspaceName: string;
};

/** A request to file: `kind` decides the statuses it moves the app between
 * (`PUBLISH_TRANSITIONS`). */
export type FileRequestInput = {
  appId: string;
  kind: AppReviewKind;
  /** None when an Agent filed the request. */
  userId: string | null;
  at: Date;
};

/** A reviewer's decision on the pending request `requestId`. */
export type DecideInput = {
  requestId: string;
  userId: string;
  outcome: AppReviewOutcome;
  reason: string | null;
  at: Date;
};

export interface AppPublishingStore {
  /** The person's role in the Workspace. */
  findMember(
    workspaceId: string,
    userId: string,
  ): Promise<{ role: WorkspaceMemberRole } | undefined>;
  /** The app `key` that `workspaceId` owns. */
  findOwned(
    workspaceId: string,
    key: string,
  ): Promise<{ appId: string; publishStatus: AppPublishStatus; description: string } | undefined>;
  /** Moves the app on from where the kind of request may be filed and files a pending request,
   * in one transaction; `false` when the app is not at such a status. */
  file(input: FileRequestInput): Promise<boolean>;
  /** Returns a publish-requested app to private and drops its pending request, in one
   * transaction; `false` when the app is not publish-requested. */
  withdraw(appId: string): Promise<boolean>;
  /** Whether the person is a platform operator who reviews apps. */
  isAppReviewer(userId: string): Promise<boolean>;
  listPending(): Promise<PendingReview[]>;
  /** Records the decision on a pending request and moves its app on, in one transaction;
   * `missing` when there is no such request, `decided` when it already has an outcome. */
  decide(input: DecideInput): Promise<"done" | "missing" | "decided">;
}

/** A publish request needs the app to say what it is: Raft refuses one without a description. */
const DESCRIPTION_REQUIRED = () =>
  new AppError("INVALID_INPUT", { errorId: "app-description-required" });
/** The app's publish status does not allow the request. */
const NOT_ALLOWED = () => new AppError("CONFLICT", { errorId: "app-publish-status-conflict" });

/**
 * Marketplace review of an app: the state machine behind `apps.publishStatus`. The owners and
 * admins of the app's Workspace request publication, withdraw that request, and request
 * unpublication; a platform operator (`app_reviewer`) decides. A repeated request is answered
 * with the state the first one reached, and an app has at most one pending request.
 *
 * Approving unpublication only makes the app private here. What happens to other Workspaces'
 * installations belongs to the install slice, which hooks in at `decide`.
 */
export class AppPublishing {
  constructor(
    private readonly store: AppPublishingStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Files a publish request; from `private` or `rejected` only. Answers the status. */
  async requestPublish(actor: PublishingActor, key: string): Promise<AppPublishStatus> {
    return this.request(actor, key, "publish");
  }

  /** Files a request to take a published app off the Marketplace. */
  async requestUnpublish(actor: PublishingActor, key: string): Promise<AppPublishStatus> {
    return this.request(actor, key, "unpublish");
  }

  /** `requestPublish` for an app an Agent manages: the request records no user. */
  async requestPublishManaged(managed: ManagedApp): Promise<AppPublishStatus> {
    return this.requestManaged(managed, "publish");
  }

  /** `requestUnpublish` for an app an Agent manages. */
  async requestUnpublishManaged(managed: ManagedApp): Promise<AppPublishStatus> {
    return this.requestManaged(managed, "unpublish");
  }

  /** Withdraws a pending publish request: the app is private again and the request is gone. */
  async withdrawPublish(actor: PublishingActor, key: string): Promise<AppPublishStatus> {
    const app = await this.ownedApp(actor, key);
    if (app.publishStatus === "private") return "private";
    if (app.publishStatus !== "publish_requested") throw NOT_ALLOWED();
    if (await this.store.withdraw(app.appId)) return "private";
    return this.settled(actor, key, "private");
  }

  /** Whether the person is a platform operator who reviews apps (the caller has already checked
   * they are a member of the Workspace). */
  async isReviewer(userId: string): Promise<boolean> {
    return this.store.isAppReviewer(userId);
  }

  /** The requests waiting for a decision, oldest first. */
  async listPendingReviews(reviewer: PublishingActor): Promise<PendingReview[]> {
    await this.assertReviewer(reviewer);
    return this.store.listPending();
  }

  /** Decides a pending request; the reason is kept for reviewers and never shown to developers. */
  async decide(
    reviewer: PublishingActor,
    requestId: string,
    decision: { outcome: AppReviewOutcome; reason?: string },
  ): Promise<void> {
    await this.assertReviewer(reviewer);
    const reason = decision.reason?.trim() || null;
    if ([...(reason ?? "")].length > REVIEW_REASON_MAX_LENGTH)
      throw new AppError("INVALID_INPUT", { errorId: "app-review-reason-invalid" });
    const outcome = await this.store.decide({
      requestId,
      userId: reviewer.actorUserId,
      outcome: decision.outcome,
      reason,
      at: this.now(),
    });
    if (outcome === "missing") throw new AppError("NOT_FOUND");
    if (outcome === "decided") throw new AppError("CONFLICT", { errorId: "app-review-decided" });
  }

  private async request(
    actor: PublishingActor,
    key: string,
    kind: AppReviewKind,
  ): Promise<AppPublishStatus> {
    return this.fileRequest(actor, key, await this.ownedApp(actor, key), kind, actor.actorUserId);
  }

  private async requestManaged(managed: ManagedApp, kind: AppReviewKind) {
    const { app } = managed;
    const owned = { appId: app.id, publishStatus: app.publishStatus, description: app.description };
    return this.fileRequest(managed, app.key, owned, kind, null);
  }

  private async fileRequest(
    workspace: { workspaceId: string },
    key: string,
    app: { appId: string; publishStatus: AppPublishStatus; description: string },
    kind: AppReviewKind,
    userId: string | null,
  ): Promise<AppPublishStatus> {
    const { from, pending } = PUBLISH_TRANSITIONS[kind];
    if (app.publishStatus === pending) return pending;
    if (!(from as readonly AppPublishStatus[]).includes(app.publishStatus)) throw NOT_ALLOWED();
    if (kind === "publish" && app.description.trim() === "") throw DESCRIPTION_REQUIRED();
    const filed = await this.store.file({ appId: app.appId, kind, userId, at: this.now() });
    return filed ? pending : this.settled(workspace, key, pending);
  }

  /** A write lost a race: answer `expected` if a concurrent request already reached it. */
  private async settled(
    actor: { workspaceId: string },
    key: string,
    expected: AppPublishStatus,
  ): Promise<AppPublishStatus> {
    const current = await this.store.findOwned(actor.workspaceId, key);
    if (current?.publishStatus === expected) return expected;
    throw NOT_ALLOWED();
  }

  /** The app is the actor's Workspace's own and its owners and admins act. */
  private async ownedApp(actor: PublishingActor, key: string) {
    await requireMarketplaceMember(this.store, actor, { manage: true });
    const app = await this.store.findOwned(actor.workspaceId, key);
    if (!app) throw new AppError("NOT_FOUND");
    return app;
  }

  private async assertReviewer(reviewer: PublishingActor) {
    await requireMarketplaceMember(this.store, reviewer, { manage: false });
    if (!(await this.store.isAppReviewer(reviewer.actorUserId)))
      throw new AppError("ACCESS_DENIED");
  }
}
