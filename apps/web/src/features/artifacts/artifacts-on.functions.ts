import { createServerFn } from "@tanstack/react-start";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { artifactsEnabled } from "#src/server/artifacts/artifact-access.server";

/** Whether documents (the `artifacts` experiment, task #385) apply in the viewer's Workspace: a
 * member may not read the experiments themselves, only whether this one is on. */
export const loadArtifactsOn = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context: { db, workspaceId } }) => ({
    on: await artifactsEnabled(db, workspaceId),
  }));
