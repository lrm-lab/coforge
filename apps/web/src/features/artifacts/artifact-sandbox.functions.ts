import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { artifactInputs } from "./artifact-inputs";
import {
  productionArtifactLinkOpen,
  productionArtifactSandbox,
} from "#src/server/artifacts/artifact-composition.server";
import { requireDatabaseClient } from "#src/server/db/client.server";
import { clientAddress, publicOrigin } from "#src/server/http/public-origin.server";

export const loadArtifactSandboxLink = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z
      .object({
        artifactId: artifactInputs.id,
        version: artifactInputs.version.optional(),
        path: z.string().min(1).max(512).optional(),
      })
      .strict(),
  )
  .handler(async ({ context, data }) => {
    const link = await productionArtifactSandbox(context.db).link({
      workspaceId: context.workspaceId,
      userId: context.user.id,
      artifactId: data.artifactId,
      version: data.version,
      path: data.path,
      embedderOrigin: publicOrigin(getRequest()),
    });
    return {
      url: link.url,
      version: link.version,
      expiresAt: link.expiresAt.toISOString(),
      viewer: link.viewer,
      level: link.level,
    };
  });

export const openLinkArtifact = createServerFn({ method: "GET" })
  .validator(z.object({ artifactId: artifactInputs.id }).strict())
  .handler(async ({ data }) => {
    return productionArtifactLinkOpen(requireDatabaseClient()).open({
      artifactId: data.artifactId,
      client: clientAddress(getRequest()),
    });
  });
