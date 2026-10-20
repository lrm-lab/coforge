import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import {
  workspaceUserMiddleware,
  type WorkspaceUserContext,
} from "#src/features/auth/function-auth";
import { declareNoStore } from "#src/features/no-store-response.server";
import { createAppRegistry } from "#src/server/apps/app-registry-composition.server";
import type { AppActor, AppView } from "#src/server/apps/app-registry.server";
import { APP_CATEGORIES } from "./app-category";
import {
  APP_DESCRIPTION_MAX_LENGTH,
  APP_KEY_MAX_LENGTH,
  APP_NAME_MAX_LENGTH,
  APP_SCOPES,
  APP_URL_MAX_LENGTH,
  APP_WHEN_TO_USE_MAX_LENGTH,
  MAX_REDIRECT_URIS,
} from "./app-registration";

/**
 * Settings → Applications. Thin wrappers over the app registry, which decides who may change which
 * app and checks every field (`APP_INPUT_ERROR_IDS`). The schemas here only bound the input's
 * shape and size, so a refused value still reaches the registry and comes back naming its field.
 */

/** An app as the Settings page shows it. */
export type AppSummary = Omit<
  AppView,
  "ownerWorkspaceId" | "secretRotatedAt" | "createdAt" | "updatedAt"
> & { createdAt: string };

const summary = ({
  ownerWorkspaceId: _owner,
  secretRotatedAt: _rotated,
  updatedAt: _updated,
  createdAt,
  ...app
}: AppView): AppSummary => ({ ...app, createdAt: createdAt.toISOString() });

/** A text the registry counts in code points; zod counts UTF-16 units, at most two per code point. */
const text = (maxCodePoints: number) => z.string().max(maxCodePoints * 2);
const url = z.string().max(APP_URL_MAX_LENGTH);

const fields = {
  name: text(APP_NAME_MAX_LENGTH),
  description: text(APP_DESCRIPTION_MAX_LENGTH),
  whenToUse: text(APP_WHEN_TO_USE_MAX_LENGTH),
  homepageUrl: url.nullable(),
  redirectUris: z.array(url).max(MAX_REDIRECT_URIS),
  // Chosen from a list, so a value outside it is a malformed request, not a field to correct.
  category: z.enum(APP_CATEGORIES),
  allowedScopes: z.array(z.string()).max(APP_SCOPES.length),
};

const keyInput = z.object({ key: z.string().max(APP_KEY_MAX_LENGTH) });

/** The member acting, in the Workspace the page URL names. */
const actorOf = ({ user, workspaceId }: WorkspaceUserContext): AppActor => ({
  workspaceId,
  actorUserId: user.id,
});

/** The apps installed in the Workspace: the ones it registered. */
export const loadWorkspaceApps = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }) => {
    declareNoStore();
    const apps = await createAppRegistry(context.db).listWorkspaceApps(actorOf(context));
    return apps.map(summary);
  });

/** Registers an app in the Workspace; a blank key asks for one made from its name. The answer
 * carries its client secret, once. */
export const registerWorkspaceApp = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(keyInput.extend(fields))
  .handler(async ({ data, context }) => {
    declareNoStore();
    const { app, clientSecret } = await createAppRegistry(context.db).registerApp(
      actorOf(context),
      data,
    );
    return { app: summary(app), clientSecret };
  });

/** Changes any field of the Workspace's app but its key. */
export const updateWorkspaceApp = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(keyInput.extend({ patch: z.object(fields).partial() }))
  .handler(async ({ data, context }) => {
    declareNoStore();
    return summary(
      await createAppRegistry(context.db).updateApp(actorOf(context), data.key, data.patch),
    );
  });

/** Replaces the app's client secret; the answer is the new one, once. */
export const rotateWorkspaceAppSecret = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(keyInput)
  .handler(async ({ data, context }) => {
    declareNoStore();
    const { clientSecret } = await createAppRegistry(context.db).rotateAppSecret(
      actorOf(context),
      data.key,
    );
    return { clientSecret };
  });

/** Deletes the Workspace's app. */
export const deleteWorkspaceApp = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(keyInput)
  .handler(async ({ data, context }) => {
    declareNoStore();
    await createAppRegistry(context.db).deleteApp(actorOf(context), data.key);
  });
