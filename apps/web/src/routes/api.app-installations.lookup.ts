import { createFileRoute } from "@tanstack/react-router";
import { appInstallationLookup } from "#src/server/authorization-server/http.server";

// An app finds its installation in a Workspace (`client_secret_basic`), behind
// `app-installation-setup`.
export const Route = createFileRoute("/api/app-installations/lookup")({
  server: {
    handlers: { POST: ({ request }): Promise<Response> => appInstallationLookup(request) },
  },
});
