import { createFileRoute } from "@tanstack/react-router";
import { appAgentRequestStatus } from "#src/server/authorization-server/http.server";

// An app reads its own Agent request, to see whether a person approved it.
export const Route = createFileRoute("/api/app-agent-requests/$requestId")({
  server: {
    handlers: {
      GET: ({ request, params }): Promise<Response> =>
        appAgentRequestStatus(request, params.requestId),
    },
  },
});
