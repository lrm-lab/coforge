import { createFileRoute } from "@tanstack/react-router";
import { authenticateLinkedDaemon } from "#src/server/auth/daemon-request.server";
import { selfComputer } from "#src/server/computers/computer-self.server";

export const Route = createFileRoute("/api/computer/self")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const daemon = await authenticateLinkedDaemon(request);
        if (daemon instanceof Response) return daemon;
        const { principal, db } = daemon;
        return selfComputer(db, principal);
      },
    },
  },
});
