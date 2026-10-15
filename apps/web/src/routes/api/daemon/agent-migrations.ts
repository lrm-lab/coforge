import { createFileRoute } from "@tanstack/react-router";
import { authenticateLinkedDaemon, parseBody } from "#src/server/auth/daemon-request.server";
import { agentMigrationServices } from "#src/server/agent-migrations/agent-migration-composition.server";
import {
  agentMigrationDaemonRequestSchema,
  answerAgentMigrationDaemonRequest,
} from "#src/server/agent-migrations/agent-migration-daemon-api.server";

export const Route = createFileRoute("/api/daemon/agent-migrations")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const daemon = await authenticateLinkedDaemon(request);
        if (daemon instanceof Response) return daemon;
        const { principal, db } = daemon;
        const input = await parseBody(request, agentMigrationDaemonRequestSchema);
        if (input instanceof Response) return input;
        const { transport, orchestrator } = await agentMigrationServices(db);
        const answer = await answerAgentMigrationDaemonRequest(
          transport,
          orchestrator,
          principal,
          input,
        );
        return Response.json(answer.body, {
          status: answer.status,
          headers: { "cache-control": "no-store" },
        });
      },
    },
  },
});
