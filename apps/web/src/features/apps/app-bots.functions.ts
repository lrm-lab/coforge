import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { declareNoStore } from "#src/features/no-store-response.server";
import { createAppBots } from "#src/server/app-bots/app-bots-composition.server";
import { actorOf } from "./app-actor";
import { APP_KEY_MAX_LENGTH } from "./app-registration";

/**
 * An app's bot, for Settings → Applications. Thin wrappers over `AppBots`, which checks that the
 * member is an owner or admin. They are not behind the `app-bot` flag, which only decides whether
 * Settings shows these controls (the reference product gates its editor the same way and leaves
 * its API open).
 */

const keyInput = z.object({ key: z.string().max(APP_KEY_MAX_LENGTH) });

/** The app declares a bot (`enableBot`), or stops declaring one, which revokes every grant and
 * disables the bots at once. Owners and admins of the Workspace that owns the app. */
export const setAppBotDeclared = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(keyInput.extend({ enabled: z.boolean() }))
  .handler(async ({ data, context }) => {
    declareNoStore();
    await createAppBots(context.db).declare(actorOf(context), data.key, data.enabled);
    return { enabled: data.enabled };
  });

/** Grants the bot to this Workspace's installation of the app ("Enable bot"). CONFLICT
 * (`app-bot-handle-conflict`) when an Agent or a member already has the app's key as a handle. */
export const grantAppBot = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(keyInput)
  .handler(async ({ data, context }) => {
    declareNoStore();
    return createAppBots(context.db).grant(actorOf(context), data.key);
  });

/** Revokes the grant ("Disable bot"): the bot is disabled and its key ends. */
export const revokeAppBot = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(keyInput)
  .handler(async ({ data, context }) => {
    declareNoStore();
    await createAppBots(context.db).revoke(actorOf(context), data.key);
    return { granted: false };
  });
