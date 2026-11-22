import { createFileRoute } from "@tanstack/react-router";
import { authenticateLinkedDaemon } from "#src/server/auth/daemon-request.server";
import {
  acceptComputerUpgradeProgress,
  readComputerUpgradeProgressReport,
} from "#src/server/computers/computer-upgrade-progress-wire.server";

export const Route = createFileRoute("/api/daemon/computer-upgrade-progress")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const daemon = await authenticateLinkedDaemon(request);
        if (daemon instanceof Response) return daemon;
        const input = await readComputerUpgradeProgressReport(request);
        if (input instanceof Response) return input;
        try {
          const status = await acceptComputerUpgradeProgress(daemon.db, daemon.principal, input);
          return new Response(null, { status });
        } catch {
          return new Response(null, { status: 503 });
        }
      },
    },
  },
});
