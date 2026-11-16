import { createFileRoute } from "@tanstack/react-router";

import { isAppError } from "#src/lib/app-error";
import { productionArtifacts } from "#src/server/artifacts/artifact-composition.server";
import { requireBrowserUser } from "#src/server/auth/require-user.server";
import { getDatabaseClient } from "#src/server/db/client.server";
import { textResponse } from "#src/server/http/text-response.server";
import { requireWorkspaceIdForSlug } from "#src/server/workspaces/selection.server";

export const Route = createFileRoute(
  "/api/workspaces/$workspaceSlug/artifacts/$artifactId/download",
)({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          const user = await requireBrowserUser(request.headers.get("cookie") ?? undefined);
          const db = getDatabaseClient();
          if (!db) return textResponse("persistence unavailable", { status: 503 });
          const workspaceId = await requireWorkspaceIdForSlug(db, user.id, params.workspaceSlug);
          const query = new URL(request.url).searchParams;
          const version = Number(query.get("version") ?? "");
          return await productionArtifacts(db).download({
            workspaceId,
            artifactId: params.artifactId,
            userId: user.id,
            path: query.get("path") ?? undefined,
            ...(Number.isInteger(version) && version > 0 ? { version } : {}),
          });
        } catch (error) {
          if (isAppError(error) && error.errorId === "artifact-zip-too-large")
            return textResponse("too large", { status: 413 });
          return textResponse("not found", { status: 404 });
        }
      },
    },
  },
});
