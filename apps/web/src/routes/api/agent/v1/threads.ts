import { createFileRoute } from "@tanstack/react-router";
import type { AgentThreadListResponse } from "@lrm/coforge-sdk/agent";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import { listAgentFollowedThreads } from "#src/server/agents/agent-thread-follows.server";

/** `GET /api/agent/v1/threads` — `coforge thread list`: the threads the calling Agent follows. */
export const Route = createFileRoute("/api/agent/v1/threads")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      GET: async ({ context: { principal, db } }) => {
        const body: AgentThreadListResponse = {
          ok: true,
          threads: await listAgentFollowedThreads(db, principal.workspaceId, principal.agentId),
        };
        return Response.json(body);
      },
    },
  },
});
