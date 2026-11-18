import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

import { declareNoStore } from "#src/features/no-store-response.server";
import { isValidWorkspaceSlug } from "#src/features/workspaces/workspace-slug";
import { productionArtifacts } from "#src/server/artifacts/artifact-composition.server";
import { optionalBrowserUser } from "#src/server/auth/require-user.server";
import { requireDatabaseClient } from "#src/server/db/client.server";

export const artifactVisitorUrl = createServerFn({ method: "GET" })
  .validator(
    z
      .object({ workspaceSlug: z.string().refine(isValidWorkspaceSlug), artifactId: z.uuid() })
      .strict(),
  )
  .handler(async ({ data }) => {
    declareNoStore();
    const cookie = getRequest().headers.get("cookie") ?? undefined;
    return productionArtifacts(requireDatabaseClient()).publicLinks.visitorUrl({
      ...data,
      reader: async () => (await optionalBrowserUser(cookie))?.id ?? null,
    });
  });
