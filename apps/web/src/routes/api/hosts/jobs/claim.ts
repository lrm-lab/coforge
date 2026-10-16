import { createFileRoute } from "@tanstack/react-router";

import { productionHostJobs } from "#src/server/hosts/host-production.server";

export const Route = createFileRoute("/api/hosts/jobs/claim")({
  server: {
    handlers: {
      POST: ({ request }) => productionHostJobs().claim(request),
    },
  },
});
