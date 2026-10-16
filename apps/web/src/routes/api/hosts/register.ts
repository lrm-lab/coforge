import { createFileRoute } from "@tanstack/react-router";

import { productionHostHttp } from "#src/server/hosts/host-production.server";

export const Route = createFileRoute("/api/hosts/register")({
  server: {
    handlers: {
      POST: ({ request }) => productionHostHttp().register(request),
    },
  },
});
