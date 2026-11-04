import { createFileRoute } from "@tanstack/react-router";
import { authenticateLinkedDaemon } from "#src/server/auth/daemon-request.server";
import { swapKey } from "#src/server/computers/computer-self.server";

export const Route = createFileRoute("/api/computer/swap-key")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const daemon = await authenticateLinkedDaemon(request);
        if (daemon instanceof Response) return daemon;
        const { principal, db } = daemon;
        return db.$transaction((tx) => swapKey(tx, principal));
      },
    },
  },
});
