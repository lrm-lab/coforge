import { createFileRoute } from "@tanstack/react-router";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import {
  handleExternalActivityPost,
  productionExternalActivityPorts,
} from "#src/server/agents/external-agent-activity-http.server";

export const Route = createFileRoute("/api/agent/v1/activity")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: ({ request, context: { principal, db } }) =>
        handleExternalActivityPost(request, principal, () => productionExternalActivityPorts(db)),
    },
  },
});
