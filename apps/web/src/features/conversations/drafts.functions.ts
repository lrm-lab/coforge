import { createServerFn } from "@tanstack/react-start";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { draftsEnabled } from "#src/server/conversations/drafts-gate.server";

/** Whether the Drafts page applies in the viewer's Workspace: a member may not read the
 * experiments themselves, only whether this one is on. */
export const loadDraftsOn = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context: { db, workspaceId } }) => ({
    on: await draftsEnabled(db, { workspaceId }),
  }));
