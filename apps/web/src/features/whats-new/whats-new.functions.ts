import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { WhatsNew, whatsNewClock } from "#src/server/whats-new/whats-new.server";

/** The "What's new" entries the viewer has still to see in this Workspace, oldest first, and the
 * latest released ones, newest first. */
export const loadWhatsNew = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context: { db, user, workspaceId } }) =>
    new WhatsNew(db, undefined, whatsNewClock()).read(user.id, workspaceId),
  );

/** Marks entries seen for the viewer, on every device. */
export const dismissWhatsNew = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ ids: z.array(z.string().min(1).max(64)).min(1).max(50) }))
  .handler(async ({ data, context: { db, user } }) => {
    await new WhatsNew(db).dismiss(user.id, ...data.ids);
    return { ok: true as const };
  });
