import { createFileRoute } from "@tanstack/react-router";

import { AuthConfigError, readSessionSecret } from "#src/server/auth/config.server";
import {
  authorizeDesktopRequest,
  userOwnsCloudComputer,
} from "#src/server/computers/desktop-proxy-auth.server";
import { getDatabaseClient } from "#src/server/db/client.server";

/**
 * Caddy asks this before it forwards `/desktop/...` to the Swarm desktop proxy.
 * The desktop path arrives in `X-Desktop-Path`, which Caddy sets from the
 * browser's request and overwrites if the browser sent one.
 */
async function authorize({ request }: { request: Request }): Promise<Response> {
  const db = getDatabaseClient();
  if (!db) return new Response(null, { status: 503, headers: { "cache-control": "no-store" } });
  try {
    return await authorizeDesktopRequest({
      desktopPath:
        request.headers.get("x-desktop-path") ?? request.headers.get("x-forwarded-uri") ?? "",
      cookieHeader: request.headers.get("cookie") ?? "",
      sessionSecret: await readSessionSecret(process.env),
      ownsCloudComputer: (userId, computerId) => userOwnsCloudComputer(db, userId, computerId),
    });
  } catch (error) {
    if (error instanceof AuthConfigError) {
      return new Response(null, { status: 503, headers: { "cache-control": "no-store" } });
    }
    throw error;
  }
}

export const Route = createFileRoute("/api/internal/desktop-authorize")({
  server: {
    handlers: {
      GET: authorize,
    },
  },
});
