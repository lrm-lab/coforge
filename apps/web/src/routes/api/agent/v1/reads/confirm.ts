import { createFileRoute } from "@tanstack/react-router";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import {
  handleAgentReadConfirm,
  productionAgentReads,
} from "#src/server/agents/agent-read-routes.server";

export const Route = createFileRoute("/api/agent/v1/reads/confirm")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: async ({ request, context: { principal, db } }) =>
        handleAgentReadConfirm(request, principal, await productionAgentReads(db)),
    },
  },
});
