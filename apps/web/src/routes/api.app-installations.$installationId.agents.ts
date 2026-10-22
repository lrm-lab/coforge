import { createFileRoute } from "@tanstack/react-router";
import { readAppInstallation } from "#src/server/app-installation-data/app-installation-data-composition.server";

// What an installed app may read of its Workspace's agents (`installation:agent`), authenticated by its
// installation token.
export const Route = createFileRoute("/api/app-installations/$installationId/agents")({
  server: {
    handlers: {
      GET: ({ request, params }): Promise<Response> =>
        readAppInstallation(request, params.installationId, "agent"),
    },
  },
});
