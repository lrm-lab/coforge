import { createFileRoute } from "@tanstack/react-router";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import { handleWakeHintsGet } from "#src/server/agents/external-wake-http.server";

export const Route = createFileRoute("/api/agent/v1/wake-hints")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      GET: ({ context: { principal, db } }) => handleWakeHintsGet(principal, db),
    },
  },
});
