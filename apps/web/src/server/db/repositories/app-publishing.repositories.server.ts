import type { Prisma } from "#src/generated/prisma/client";
import type { AppCategory } from "#src/features/apps/app-category";
import {
  PUBLISH_TRANSITIONS,
  type AppPublishStatus,
  type AppReviewKind,
} from "#src/features/apps/app-publish-status";
import type {
  AppPublishingStore,
  DecideInput,
  FileRequestInput,
  PendingReview,
} from "#src/server/app-marketplace/app-publishing.server";
import { findAppMember } from "#src/server/db/repositories/app.repositories.server";
import { inTransaction } from "#src/server/db/transaction.server";

/** Review requests and the publish status they move. A request's state changes only together
 * with its app's, inside one transaction; who may ask and who may decide stay in
 * `server/app-marketplace/`. */
export class PrismaAppPublishingStore implements AppPublishingStore {
  constructor(private readonly db: Prisma.TransactionClient) {}

  findMember(workspaceId: string, userId: string) {
    return findAppMember(this.db, workspaceId, userId);
  }

  async findOwned(workspaceId: string, key: string) {
    const row = await this.db.app.findFirst({
      where: { key, ownerWorkspaceId: workspaceId },
      select: { id: true, publishStatus: true, description: true },
    });
    return row
      ? {
          appId: row.id,
          publishStatus: row.publishStatus as AppPublishStatus,
          description: row.description,
        }
      : undefined;
  }

  file(input: FileRequestInput) {
    const { from, pending } = PUBLISH_TRANSITIONS[input.kind];
    return inTransaction(this.db, async (tx) => {
      const { count } = await tx.app.updateMany({
        where: { id: input.appId, publishStatus: { in: [...from] } },
        data: { publishStatus: pending },
      });
      if (count === 0) return false;
      await tx.appReviewRequest.create({
        data: {
          appId: input.appId,
          kind: input.kind,
          requestedByUserId: input.userId,
          requestedAt: input.at,
        },
      });
      return true;
    });
  }

  withdraw(appId: string) {
    return inTransaction(this.db, async (tx) => {
      const { count } = await tx.app.updateMany({
        where: { id: appId, publishStatus: "publish_requested" },
        data: { publishStatus: "private" },
      });
      if (count === 0) return false;
      await tx.appReviewRequest.deleteMany({ where: { appId, outcome: null } });
      return true;
    });
  }

  async isAppReviewer(userId: string) {
    const row = await this.db.platformOperator.findUnique({
      where: { userId },
      select: { role: true },
    });
    return row?.role === "app_reviewer";
  }

  /** The logo of app `key` of `workspaceId` for a platform reviewer, while the app has a review
   * request waiting; the member path (`findLogo`) is tried first and never pays for this. */
  async findLogoForReview({
    workspaceId,
    key,
    viewerUserId,
  }: {
    workspaceId: string;
    key: string;
    viewerUserId: string;
  }) {
    if (!(await this.isAppReviewer(viewerUserId))) return undefined;
    const row = await this.db.app.findFirst({
      where: {
        key,
        ownerWorkspaceId: workspaceId,
        reviewRequests: { some: { outcome: null } },
      },
      select: { logoObjectKey: true, logoContentType: true },
    });
    if (!row?.logoObjectKey || !row.logoContentType) return undefined;
    return { objectKey: row.logoObjectKey, contentType: row.logoContentType };
  }

  async listPending(): Promise<PendingReview[]> {
    const rows = await this.db.appReviewRequest.findMany({
      where: { outcome: null },
      orderBy: [{ requestedAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        kind: true,
        requestedAt: true,
        app: {
          select: {
            key: true,
            name: true,
            description: true,
            category: true,
            homepageUrl: true,
            allowedScopes: true,
            permissionGroups: true,
            notificationEvents: true,
            ownerWorkspaceId: true,
            logoObjectKey: true,
            ownerWorkspace: { select: { name: true } },
          },
        },
      },
    });
    return rows.map(({ id, kind, requestedAt, app: { ownerWorkspace, ...app } }) => ({
      requestId: id,
      kind: kind as AppReviewKind,
      requestedAt,
      app: { ...app, category: app.category as AppCategory },
      publisherWorkspaceName: ownerWorkspace.name,
    }));
  }

  decide(input: DecideInput) {
    return inTransaction(this.db, async (tx) => {
      const request = await tx.appReviewRequest.findUnique({
        where: { id: input.requestId },
        select: { appId: true, kind: true, outcome: true },
      });
      if (!request) return "missing" as const;
      if (request.outcome !== null) return "decided" as const;
      const { count } = await tx.appReviewRequest.updateMany({
        where: { id: input.requestId, outcome: null },
        data: {
          outcome: input.outcome,
          reason: input.reason,
          decidedByUserId: input.userId,
          decidedAt: input.at,
        },
      });
      if (count === 0) return "decided" as const;
      const kind = request.kind as AppReviewKind;
      const approved = input.outcome === "approved";
      const transition = PUBLISH_TRANSITIONS[kind];
      await tx.app.updateMany({
        where: { id: request.appId, publishStatus: transition.pending },
        data: {
          publishStatus: approved ? transition.approved : transition.rejected,
          ...(kind === "publish" && approved && { publishedAt: input.at }),
        },
      });
      return "done" as const;
    });
  }
}
