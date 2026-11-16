import { createFileRoute } from "@tanstack/react-router";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import { teamMemory } from "#src/server/team-memory/composition.server";
import { handleTeamMemory } from "#src/server/team-memory/http.server";

export const Route = createFileRoute("/api/agent/v1/team-memory")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: ({ request, context: { principal, db } }) =>
        handleTeamMemory(request, principal, teamMemory(db)),
    },
  },
});
