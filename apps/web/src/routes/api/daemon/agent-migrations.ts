import { createFileRoute } from "@tanstack/react-router";
import { authenticateLinkedDaemon, parseBody } from "#src/server/auth/daemon-request.server";
import { AgentMigrations } from "#src/server/agent-migrations/agent-migrations.server";
import { AgentMigrationTransport } from "#src/server/agent-migrations/agent-migration-transport.server";
import {
  agentMigrationDaemonRequestSchema,
  answerAgentMigrationDaemonRequest,
} from "#src/server/agent-migrations/agent-migration-daemon-api.server";
import { getAgentMigrationStorage } from "#src/server/agent-migrations/agent-migration-storage.server";
import { PrismaAgentMigrationStore } from "#src/server/db/repositories/agent-migration.repositories.server";

export const Route = createFileRoute("/api/daemon/agent-migrations")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const daemon = await authenticateLinkedDaemon(request);
        if (daemon instanceof Response) return daemon;
        const { principal, db } = daemon;
        const input = await parseBody(request, agentMigrationDaemonRequestSchema);
        if (input instanceof Response) return input;
        const transport = new AgentMigrationTransport(
          new AgentMigrations(new PrismaAgentMigrationStore(db)),
          await getAgentMigrationStorage(),
        );
        const answer = await answerAgentMigrationDaemonRequest(transport, principal, input);
        return Response.json(answer.body, {
          status: answer.status,
          headers: { "cache-control": "no-store" },
        });
      },
    },
  },
});
