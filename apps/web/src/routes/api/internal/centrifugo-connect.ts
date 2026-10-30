import { createFileRoute } from "@tanstack/react-router";

import {
  authenticateCentrifugoConnect,
  centrifugoConnectDependencies,
} from "#src/server/centrifugo/connect-proxy.server";
import { fromCentrifugoProxy } from "#src/server/centrifugo/proxy-secret.server";
import { getDatabaseClient } from "#src/server/db/client.server";

export const Route = createFileRoute("/api/internal/centrifugo-connect")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!fromCentrifugoProxy(request))
          return Response.json(
            { error: { code: 403, message: "proxy authorization failed" } },
            { status: 403 },
          );
        const db = getDatabaseClient();
        if (!db)
          return Response.json(
            { error: { code: 503, message: "database unavailable" } },
            { status: 503 },
          );
        return authenticateCentrifugoConnect(request, centrifugoConnectDependencies(db));
      },
    },
  },
});
