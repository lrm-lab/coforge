import { createFileRoute } from "@tanstack/react-router";

import { cliInstallPs1Handler } from "#src/server/install/install-script.server";

export const Route = createFileRoute("/cli/install.ps1")({
  server: { handlers: { GET: () => cliInstallPs1Handler() } },
});
