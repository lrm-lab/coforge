import { createFileRoute } from "@tanstack/react-router";
import { appInstallationSetup } from "#src/server/authorization-server/http.server";

// An installation's setup status, read and reported by its app with an installation token, behind
// `app-installation-setup`.
export const Route = createFileRoute("/api/app-installations/$installationId/setup")({
  server: {
    handlers: {
      GET: ({ request, params }): Promise<Response> =>
        appInstallationSetup(request, params.installationId),
      PUT: ({ request, params }): Promise<Response> =>
        appInstallationSetup(request, params.installationId),
    },
  },
});
