import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { declareNoStore } from "#src/features/no-store-response.server";
import { createAppInstallations } from "#src/server/app-marketplace/app-installations-composition.server";
import { actorOf } from "./app-actor";
import type { AppCategory } from "./app-category";
import { toMarketplaceApp } from "./marketplace-app.server";
import { APP_KEY_MAX_LENGTH } from "./app-registration";

/**
 * The Marketplace tab of Settings → Applications (`server/app-marketplace/`): the apps other
 * Workspaces published, and installing and uninstalling them. Thin wrappers; the module decides
 * who may do what.
 */

const keyInput = z.object({ key: z.string().max(APP_KEY_MAX_LENGTH) });

/** What the Marketplace tab and a private share page show of an app. */
export type MarketplaceAppInfo = {
  key: string;
  name: string;
  description: string;
  category: AppCategory;
  /** The developer: the name of the Workspace that registered the app. */
  developer: string;
  homepageUrl: string | null;
  /** The host of `homepageUrl`, computed here so a surface does not parse the URL per render. */
  homepageHost: string | null;
  /** The distinct hosts of the app's callback URLs. */
  callbackDomains: string[];
  allowedScopes: string[];
  permissionGroups: string[];
  notificationEvents: string[];
  /** The declaration an install approves; sent back with the install. */
  permissionRevision: number;
  logoUrl: string | null;
  installCount: number;
  publishedAt: string | null;
};

/** A published app as the Marketplace tab shows it. */
export type MarketplaceApp = MarketplaceAppInfo & {
  installed: boolean;
  /** An install approves exactly the declarations shown (`app-data-permissions` is on here). */
  approvesOnInstall: boolean;
};

/** The apps other Workspaces published (every member), with whether this one installed each. */
export const loadMarketplaceApps = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }): Promise<MarketplaceApp[]> => {
    declareNoStore();
    const { listings, approvesOnInstall } = await createAppInstallations(context.db).browse(
      actorOf(context),
    );
    return listings.map((listing) => toMarketplaceApp(listing, approvesOnInstall));
  });

/** Installs a listed app in the Workspace (owners and admins) and approves the `revision` of its
 * declarations that the installer was shown; CONFLICT (`app-permissions-changed`) once it moved on. */
export const installMarketplaceApp = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(keyInput.extend({ revision: z.number().int().nonnegative() }))
  .handler(async ({ data, context }) => {
    declareNoStore();
    await createAppInstallations(context.db).install(actorOf(context), data.key, data.revision);
  });

/** Uninstalls an app another Workspace owns from this Workspace, revoking its grants and tokens. */
export const uninstallMarketplaceApp = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(keyInput)
  .handler(async ({ data, context }) => {
    declareNoStore();
    await createAppInstallations(context.db).uninstall(actorOf(context), data.key);
  });
