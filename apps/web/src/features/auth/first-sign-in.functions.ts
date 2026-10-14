import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

import { authMiddleware } from "#src/features/auth/function-auth";
import { declareNoStore } from "#src/features/no-store-response.server";
import {
  completeFirstSignIn,
  readNameStep,
  workspaceSlugAvailable,
} from "#src/server/auth/first-sign-in.server";
import { requireDatabaseClient } from "#src/server/db/client.server";

/** Whether the signed-in person still has to be asked for a name, and what to start the field
 * with. */
export const getNameStep = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    declareNoStore();
    return readNameStep({ db: requireDatabaseClient(), user: context.user });
  });

/** Makes the personal Workspace at the chosen URL and saves the display name; `{ ok: false }` names
 * why a name or URL was not accepted. */
export const submitDisplayName = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ displayName: z.string(), workspaceSlug: z.string().max(200) }))
  .handler(async ({ data, context }) =>
    completeFirstSignIn({
      db: requireDatabaseClient(),
      user: context.user,
      displayName: data.displayName,
      workspaceSlug: data.workspaceSlug,
      acceptLanguage: getRequest().headers.get("accept-language") ?? "",
    }),
  );

/** Whether the Workspace URL the person is typing is free; the submit decides for good. */
export const checkWorkspaceSlug = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(z.object({ slug: z.string().max(200) }))
  .handler(({ data }) => workspaceSlugAvailable({ db: requireDatabaseClient(), slug: data.slug }));
