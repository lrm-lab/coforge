import { createFileRoute } from "@tanstack/react-router";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import { handleWakeStreamGet } from "#src/server/agents/external-wake-http.server";

export const Route = createFileRoute("/api/agent/v1/wake-hints_/stream")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      GET: ({ request, context: { principal, db } }) => handleWakeStreamGet(request, principal, db),
    },
  },
});
