import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { artifactInputs } from "./artifact-inputs";
import { productionArtifactSandbox } from "#src/server/artifacts/artifact-composition.server";
import { publicOrigin } from "#src/server/http/public-origin.server";

/**
 * The link a web-page artifact opens with (task #490): a short-lived signed URL on the sandbox
 * origin, for the signed-in person, at a version (the current one by default). The pane frames
 * it and "Open in new tab" opens it; it asks again each time it shows a page.
 */
export const loadArtifactSandboxLink = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z
      .object({ artifactId: artifactInputs.id, version: artifactInputs.version.optional() })
      .strict(),
  )
  .handler(async ({ context, data }) => {
    const link = await productionArtifactSandbox(context.db).link({
      workspaceId: context.workspaceId,
      userId: context.user.id,
      artifactId: data.artifactId,
      version: data.version,
      embedderOrigin: publicOrigin(getRequest()),
    });
    return { url: link.url, version: link.version, expiresAt: link.expiresAt.toISOString() };
  });
