import { createFileRoute } from "@tanstack/react-router";
import { appAgentRequest } from "#src/server/authorization-server/http.server";

// An installed app asks to send events to one Agent (`client_secret_basic`), behind
// `app-agent-events`.
export const Route = createFileRoute("/api/app-agent-requests")({
  server: { handlers: { POST: ({ request }): Promise<Response> => appAgentRequest(request) } },
});
