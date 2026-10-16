import { createFileRoute } from "@tanstack/react-router";

import { productionHostHttp } from "#src/server/hosts/host-production.server";

export const Route = createFileRoute("/api/hosts/heartbeat")({
  server: {
    handlers: {
      POST: ({ request }) => productionHostHttp().heartbeat(request),
    },
  },
});
