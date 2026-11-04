import { createFileRoute } from "@tanstack/react-router";
import { authenticateLinkedDaemon } from "#src/server/auth/daemon-request.server";
import { detachComputer } from "#src/server/computers/computer-self.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { getWorkspaceComputerInvalidation } from "#src/server/agents/workspace-computer-invalidation.server";

export const Route = createFileRoute("/api/computer/detach")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const daemon = await authenticateLinkedDaemon(request);
        if (daemon instanceof Response) return daemon;
        const { principal, db } = daemon;
        const api = createCentrifugoServerApi();
        return detachComputer(
          db,
          api,
          (computerId) => getWorkspaceComputerInvalidation().notify(computerId),
          principal,
        );
      },
    },
  },
});
