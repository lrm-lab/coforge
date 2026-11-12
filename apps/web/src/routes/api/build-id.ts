import { createFileRoute } from "@tanstack/react-router";

import { readBuildId } from "#src/server/runtime/build-id.server";

export const Route = createFileRoute("/api/build-id")({
  server: {
    handlers: {
      GET: () =>
        Response.json({ buildId: readBuildId() }, { headers: { "cache-control": "no-store" } }),
    },
  },
});
