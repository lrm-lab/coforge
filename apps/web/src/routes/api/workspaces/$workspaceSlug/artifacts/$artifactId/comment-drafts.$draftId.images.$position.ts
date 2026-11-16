import { createFileRoute } from "@tanstack/react-router";

import { productionArtifacts } from "#src/server/artifacts/artifact-composition.server";
import { requireBrowserUser } from "#src/server/auth/require-user.server";
import { getDatabaseClient } from "#src/server/db/client.server";
import { textResponse } from "#src/server/http/text-response.server";
import { requireWorkspaceIdForSlug } from "#src/server/workspaces/selection.server";

export const Route = createFileRoute(
  "/api/workspaces/$workspaceSlug/artifacts/$artifactId/comment-drafts/$draftId/images/$position",
)({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          const user = await requireBrowserUser(request.headers.get("cookie") ?? undefined);
          const db = getDatabaseClient();
          if (!db) return textResponse("persistence unavailable", { status: 503 });
          const workspaceId = await requireWorkspaceIdForSlug(db, user.id, params.workspaceSlug);
          const image = await productionArtifacts(db).drafts.readImage({
            workspaceId,
            artifactId: params.artifactId,
            userId: user.id,
            draftId: params.draftId,
            position: Number(params.position),
          });
          return new Response(Uint8Array.from(image.bytes), {
            headers: {
              "Content-Type": image.contentType,
              "Cache-Control": "private, max-age=3600",
              "X-Content-Type-Options": "nosniff",
              "Content-Security-Policy": "default-src 'none'; sandbox",
            },
          });
        } catch {
          return textResponse("not found", { status: 404 });
        }
      },
    },
  },
});
