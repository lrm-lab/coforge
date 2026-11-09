import { createFileRoute } from "@tanstack/react-router";
import { receiveAgentContextViewResult } from "#src/server/agents/agent-context-view-result-http.server";

export const Route = createFileRoute("/internal/computer/agent-context/$requestId")({
  server: {
    handlers: {
      POST: ({ request, params }) => receiveAgentContextViewResult(request, params.requestId),
    },
  },
});
