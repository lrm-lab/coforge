import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { declareNoStore } from "#src/features/no-store-response.server";
import { createAppShareLinks } from "#src/server/app-marketplace/app-share-links-composition.server";
import { actorOf } from "./app-actor";
import { APP_KEY_MAX_LENGTH } from "./app-registration";

/**
 * The share link card of the app editor's Distribution section (`server/app-marketplace/`). Thin
 * wrappers; the module decides who may do what. Dates cross as ISO strings.
 */

const keyInput = z.object({ key: z.string().max(APP_KEY_MAX_LENGTH) });

/** An app's active share link as the card shows it: when it was made and ends, never its URL. */
export type AppShareLinkStatus = { createdAt: string; expiresAt: string } | null;

/** When the app's active link ends, or null for none. */
export const loadAppShareLink = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(keyInput)
  .handler(async ({ data, context }): Promise<AppShareLinkStatus> => {
    declareNoStore();
    const status = await createAppShareLinks(context.db).status(actorOf(context), data.key);
    return (
      status && {
        createdAt: status.createdAt.toISOString(),
        expiresAt: status.expiresAt.toISOString(),
      }
    );
  });

/** Creates the link, revoking the previous one. The token comes back here and nowhere else;
 * `path` is the page it opens, which the browser prefixes with its own origin. */
export const createAppShareLink = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(keyInput)
  .handler(async ({ data, context }) => {
    declareNoStore();
    const link = await createAppShareLinks(context.db).create(actorOf(context), data.key);
    return {
      path: `/apps/share/${link.token}`,
      createdAt: link.createdAt.toISOString(),
      expiresAt: link.expiresAt.toISOString(),
    };
  });

/** Revokes the active link: no new installs from it; the Workspaces that installed keep the app. */
export const revokeAppShareLink = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(keyInput)
  .handler(async ({ data, context }) => {
    declareNoStore();
    await createAppShareLinks(context.db).revoke(actorOf(context), data.key);
  });
