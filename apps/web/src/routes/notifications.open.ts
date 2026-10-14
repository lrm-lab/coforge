import { createFileRoute } from "@tanstack/react-router";

import { deLocalizeHref } from "#src/paraglide/runtime";
import { requireBrowserUser } from "#src/server/auth/require-user.server";
import { getDatabaseClient } from "#src/server/db/client.server";
import { notificationOpenResponse } from "#src/server/notifications/open-notification.server";
import { requireWorkspaceIdForSlug } from "#src/server/workspaces/selection.server";

export const Route = createFileRoute("/notifications/open")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const user = await requireBrowserUser(
          request.headers.get("cookie") ?? undefined,
          deLocalizeHref(`${url.pathname}${url.search}`),
        );
        const db = getDatabaseClient();
        if (!db) return new Response(null, { status: 503 });
        return notificationOpenResponse({
          request,
          userId: user.id,
          // A notification sent before the Workspace's URL changed names a former slug; the
          // Workspace page then moves to the current one.
          canAccessWorkspace: async (userId, slug) =>
            requireWorkspaceIdForSlug(db, userId, slug).then(
              () => true,
              () => false,
            ),
        });
      },
    },
  },
});
