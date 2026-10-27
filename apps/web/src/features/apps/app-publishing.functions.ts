import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { declareNoStore } from "#src/features/no-store-response.server";
import { createAppPublishing } from "#src/server/app-marketplace/app-publishing-composition.server";
import { appLogoUrl } from "#src/server/apps/app-logo.server";
import type { AppCategory } from "./app-category";
import {
  REVIEW_REASON_MAX_LENGTH,
  type AppPublishStatus,
  type AppReviewKind,
} from "./app-publish-status";
import { APP_KEY_MAX_LENGTH } from "./app-registration";

/**
 * Marketplace review (`server/app-marketplace/`): the developer's requests from the app editor's
 * Distribution section, and a platform operator's review queue. Thin wrappers; the module decides
 * who may do what.
 */

const keyInput = z.object({ key: z.string().max(APP_KEY_MAX_LENGTH) });

const actorOf = ({ user, workspaceId }: { user: { id: string }; workspaceId: string }) => ({
  workspaceId,
  actorUserId: user.id,
});

type PublishStep = "requestPublish" | "withdrawPublish" | "requestUnpublish";

/** Runs one request on the Workspace's app and answers the status it reached. Each server function
 * below stays a top-level `createServerFn` so the compiler can strip its handler from the client. */
const publishStep = async (
  step: PublishStep,
  {
    data,
    context,
  }: {
    data: { key: string };
    context: Parameters<typeof actorOf>[0] & { db: Parameters<typeof createAppPublishing>[0] };
  },
): Promise<{ publishStatus: AppPublishStatus }> => {
  declareNoStore();
  const publishStatus = await createAppPublishing(context.db)[step](actorOf(context), data.key);
  return { publishStatus };
};

/** Asks for the Workspace's app to be listed in the Marketplace; the answer is its new status. */
export const requestAppPublish = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(keyInput)
  .handler((input) => publishStep("requestPublish", input));

/** Withdraws the app's pending publish request; the app is private again. */
export const withdrawAppPublish = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(keyInput)
  .handler((input) => publishStep("withdrawPublish", input));

/** Asks for the published app to be taken off the Marketplace; it stays listed until approved. */
export const requestAppUnpublish = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(keyInput)
  .handler((input) => publishStep("requestUnpublish", input));

/** A request waiting for a reviewer, as the review page shows it. */
export type ReviewRequestSummary = {
  requestId: string;
  kind: AppReviewKind;
  requestedAt: string;
  publisherWorkspaceName: string;
  app: {
    key: string;
    name: string;
    description: string;
    category: AppCategory;
    homepageUrl: string | null;
    allowedScopes: string[];
    permissionGroups: string[];
    notificationEvents: string[];
    logoUrl: string | null;
  };
};

/** The requests waiting for a decision (platform operators only; ACCESS_DENIED for anyone else). */
export const loadAppReviews = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }): Promise<ReviewRequestSummary[]> => {
    declareNoStore();
    const pending = await createAppPublishing(context.db).listPendingReviews(actorOf(context));
    return pending.map(({ requestedAt, app, ...request }) => {
      const { ownerWorkspaceId, logoObjectKey, ...shown } = app;
      return {
        ...request,
        requestedAt: requestedAt.toISOString(),
        app: { ...shown, logoUrl: appLogoUrl(ownerWorkspaceId, app.key, logoObjectKey) },
      };
    });
  });

/** Approves or rejects a pending request; a rejection may carry a reason, kept for reviewers. */
export const decideAppReview = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      requestId: z.uuid(),
      outcome: z.enum(["approved", "rejected"]),
      reason: z
        .string()
        .max(REVIEW_REASON_MAX_LENGTH * 2)
        .optional(),
    }),
  )
  .handler(async ({ data, context }) => {
    declareNoStore();
    await createAppPublishing(context.db).decide(actorOf(context), data.requestId, {
      outcome: data.outcome,
      reason: data.reason,
    });
  });
