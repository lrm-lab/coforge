import { createFileRoute } from "@tanstack/react-router";

import { requireBrowserUser } from "#src/server/auth/require-user.server";
import { getDatabaseClient } from "#src/server/db/client.server";
import { requireWorkspaceIdForSlug } from "#src/server/workspaces/selection.server";
import { recordCatalog } from "#src/server/records/record-catalog.server";

export const Route = createFileRoute(
  "/api/workspaces/$workspaceSlug/weekly-reports/$reportId/html",
)({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          const user = await requireBrowserUser(request.headers.get("cookie") ?? undefined);
          const db = getDatabaseClient();
          if (!db) return new Response("persistence unavailable", { status: 503 });
          // By its current or a former slug: a link made before the Workspace's URL changed. A
          // Workspace the User is not in throws, which answers 404 below.
          const workspaceId = await requireWorkspaceIdForSlug(db, user.id, params.workspaceSlug);
          const result = await recordCatalog(db).exportWeeklyReportHtml({
            workspaceId,
            userId: user.id,
            overviewReportId: params.reportId,
          });
          return new Response(result.bytes.slice().buffer as ArrayBuffer, {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(result.fileName)}`,
              "Cache-Control": "private, no-store",
              "X-Content-Type-Options": "nosniff",
            },
          });
        } catch {
          return new Response("not found", { status: 404 });
        }
      },
    },
  },
});
