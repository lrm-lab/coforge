import { createFileRoute } from "@tanstack/react-router";
import { readAppInstallation } from "#src/server/app-installation-data/app-installation-data-composition.server";

// What an installed app may read of its Workspace's computers (`installation:computer`), authenticated by its
// installation token.
export const Route = createFileRoute("/api/app-installations/$installationId/computers")({
  server: {
    handlers: {
      GET: ({ request, params }): Promise<Response> =>
        readAppInstallation(request, params.installationId, "computer"),
    },
  },
});
