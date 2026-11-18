import { createFileRoute } from "@tanstack/react-router";

import { productionArtifacts } from "#src/server/artifacts/artifact-composition.server";
import { requireBrowserUser } from "#src/server/auth/require-user.server";
import { getDatabaseClient } from "#src/server/db/client.server";
import { PRIVATE_NO_STORE } from "#src/server/http/cache-control.server";
import { textResponse } from "#src/server/http/text-response.server";
import { requireWorkspaceIdForSlug } from "#src/server/workspaces/selection.server";

const UNCACHED = { "Cache-Control": PRIVATE_NO_STORE };

export const Route = createFileRoute(
  "/api/workspaces/$workspaceSlug/artifacts/$artifactId/thumbnail",
)({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          const query = new URL(request.url).searchParams;
          const version = Number(query.get("version"));
          const path = query.get("path");
          if (!path || !Number.isInteger(version) || version < 1)
            return textResponse("path and version required", { status: 400, headers: UNCACHED });
          const user = await requireBrowserUser(request.headers.get("cookie") ?? undefined);
          const db = getDatabaseClient();
          if (!db)
            return textResponse("persistence unavailable", { status: 503, headers: UNCACHED });
          const workspaceId = await requireWorkspaceIdForSlug(db, user.id, params.workspaceSlug);
          return await productionArtifacts(db).thumbnail({
            workspaceId,
            artifactId: params.artifactId,
            userId: user.id,
            version,
            path,
          });
        } catch {
          return textResponse("not found", { status: 404, headers: UNCACHED });
        }
      },
    },
  },
});
