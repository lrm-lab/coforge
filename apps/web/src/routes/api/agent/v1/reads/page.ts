import { createFileRoute } from "@tanstack/react-router";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import {
  handleAgentReadPage,
  productionAgentReads,
} from "#src/server/agents/agent-read-routes.server";

export const Route = createFileRoute("/api/agent/v1/reads/page")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: async ({ request, context: { principal, db } }) =>
        handleAgentReadPage(request, principal, await productionAgentReads(db)),
    },
  },
});
