import { createFileRoute } from "@tanstack/react-router";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import { isExternalAgentPrincipal } from "#src/server/agents/external-agent-credentials.server";
import { readAgentContext } from "#src/server/agents/agent-context.server";

export const Route = createFileRoute("/api/agent/v1/context")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      GET: async ({ context: { principal, db } }) => {
        const view = await readAgentContext(db, {
          workspaceId: principal.workspaceId,
          agentId: principal.agentId,
          ...(isExternalAgentPrincipal(principal)
            ? { external: principal.external, credentialId: principal.credentialId }
            : {}),
        });
        return view ? Response.json(view) : Response.json({ error: "not found" }, { status: 404 });
      },
    },
  },
});
