import { createFileRoute } from "@tanstack/react-router";
import { appAgentEvent } from "#src/server/authorization-server/http.server";

// An app posts an event or a notification to the Agent its Agent inbound token is bound to.
export const Route = createFileRoute("/api/app-agent-events")({
  server: { handlers: { POST: ({ request }): Promise<Response> => appAgentEvent(request) } },
});
