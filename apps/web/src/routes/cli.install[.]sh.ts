import { createFileRoute } from "@tanstack/react-router";

import { cliInstallShHandler } from "#src/server/install/install-script.server";

export const Route = createFileRoute("/cli/install.sh")({
  server: { handlers: { GET: () => cliInstallShHandler() } },
});
