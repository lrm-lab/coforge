import { createFileRoute } from "@tanstack/react-router";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import { handleMemoryDispositionHttp } from "#src/server/workspace-memory/memory-disposition-http.server";

export const Route = createFileRoute("/api/agent/v1/memory-dispositions")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: async ({ request, context: { principal, db } }): Promise<Response> =>
        handleMemoryDispositionHttp({
          db,
          workspaceId: principal.workspaceId,
          agentId: principal.agentId,
          body: await request.json().catch(() => null),
        }),
    },
  },
});
