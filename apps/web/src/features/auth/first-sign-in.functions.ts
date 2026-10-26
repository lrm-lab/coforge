import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

import { authMiddleware } from "#src/features/auth/function-auth";
import { joinTokenFromReturnTo } from "#src/features/auth/return-to";
import { declareNoStore } from "#src/features/no-store-response.server";
import {
  completeFirstSignIn,
  readNameStep,
  workspaceSlugAvailable,
} from "#src/server/auth/first-sign-in.server";
import { requireDatabaseClient } from "#src/server/db/client.server";

const returnToField = z.string().max(2_048).optional();

/** Whether the signed-in person still has to be asked for a name, and what to start the field
 * with. `returnTo` lets the server say whether it is a working invite's join page. */
export const getNameStep = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(z.object({ returnTo: returnToField }))
  .handler(async ({ data, context }) => {
    declareNoStore();
    return readNameStep({
      db: requireDatabaseClient(),
      user: context.user,
      returnTo: data.returnTo,
    });
  });

/** Makes the personal Workspace at the chosen URL and saves the display name; `{ ok: false }` names
 * why a name or URL was not accepted. Without a URL and with a working invite's join page as
 * `returnTo`, it saves the name only; the server alone decides that, from `returnTo`. */
export const submitDisplayName = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      displayName: z.string(),
      workspaceSlug: z.string().max(200).optional(),
      returnTo: returnToField,
    }),
  )
  .handler(async ({ data, context }) => {
    // The URL is required for a personal Workspace; only an invite's join page may go without one
    // (`complete` then decides whether the link works), so nothing else gets a derived URL.
    if (data.workspaceSlug === undefined && joinTokenFromReturnTo(data.returnTo) === undefined)
      return { ok: false, problem: "slug_invalid" } as const;
    return completeFirstSignIn({
      db: requireDatabaseClient(),
      user: context.user,
      displayName: data.displayName,
      workspaceSlug: data.workspaceSlug,
      returnTo: data.returnTo,
      acceptLanguage: getRequest().headers.get("accept-language") ?? "",
    });
  });

/** Whether the Workspace URL the person is typing is free; the submit decides for good. */
export const checkWorkspaceSlug = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(z.object({ slug: z.string().max(200) }))
  .handler(({ data }) => workspaceSlugAvailable({ db: requireDatabaseClient(), slug: data.slug }));
