import { createFileRoute } from "@tanstack/react-router";

import { productionHostJobs } from "#src/server/hosts/host-production.server";

export const Route = createFileRoute("/api/hosts/jobs/$jobId/report")({
  server: {
    handlers: {
      POST: ({ request, params }) => productionHostJobs().report(request, params.jobId),
    },
  },
});
