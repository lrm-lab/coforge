import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { authMiddleware } from "#src/features/auth/function-auth";
import { declareNoStore } from "#src/features/no-store-response.server";
import type { SharedInstallTarget } from "#src/server/app-marketplace/app-installations.server";
import { createAppInstallations } from "#src/server/app-marketplace/app-installations-composition.server";
import { requireDatabaseClient } from "#src/server/db/client.server";
import type { MarketplaceAppInfo } from "./app-marketplace.functions";
import { toMarketplaceAppInfo } from "./marketplace-app.server";

/**
 * The page a private share link opens (`/apps/share/<token>`), outside any Workspace: any signed-in
 * person sees the app, and installs it in a Workspace where they own or administer
 * (`AppInstallations.previewShared`, `installShared`). A dead link is NOT_FOUND.
 */

// Loose on purpose: whatever the token is, the lookup decides, and a malformed, over-long or
// unknown one reads as NOT_FOUND like any other dead link.
const tokenInput = z.object({ token: z.string() });

export type { SharedInstallTarget };

export type SharedApp = {
  app: MarketplaceAppInfo;
  expiresAt: string;
  targets: SharedInstallTarget[];
};

export const loadSharedApp = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(tokenInput)
  .handler(async ({ data, context }): Promise<SharedApp> => {
    declareNoStore();
    const { app, expiresAt, targets } = await createAppInstallations(
      requireDatabaseClient(),
    ).previewShared(context.user.id, data.token);
    return {
      app: toMarketplaceAppInfo(app, data.token),
      expiresAt: expiresAt.toISOString(),
      targets,
    };
  });

/** Installs the shared app in `workspaceId` (owners and admins), approving the `revision` of its
 * declarations that was shown; CONFLICT (`app-permissions-changed`) once it moved on. */
export const installSharedApp = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(tokenInput.extend({ workspaceId: z.uuid(), revision: z.number().int().nonnegative() }))
  .handler(async ({ data, context }) => {
    declareNoStore();
    await createAppInstallations(requireDatabaseClient()).installShared(
      { workspaceId: data.workspaceId, actorUserId: context.user.id },
      data.token,
      data.revision,
    );
  });
