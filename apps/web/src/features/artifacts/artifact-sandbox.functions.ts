import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { artifactInputs } from "./artifact-inputs";
import { productionArtifactSandbox } from "#src/server/artifacts/artifact-composition.server";
import { publicOrigin } from "#src/server/http/public-origin.server";

/** The single-use link a web-page artifact opens with: a short-lived signed URL on the artifact's
 * own origin, for the signed-in person, at a version (the current one by default), with the person
 * as the page may ask who they are. Asked again each time a page shows. */
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
    return {
      url: link.url,
      version: link.version,
      expiresAt: link.expiresAt.toISOString(),
      viewer: link.viewer,
    };
  });
