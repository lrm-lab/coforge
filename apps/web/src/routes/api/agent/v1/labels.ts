import { createFileRoute } from "@tanstack/react-router";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import { Labels } from "#src/server/tasks/labels.server";

/** `coforge label list`: the Workspace's labels with their group, counts and last use. */
export const Route = createFileRoute("/api/agent/v1/labels")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      GET: async ({ context: { principal, db } }) =>
        Response.json({ labels: await new Labels(db).listForWorkspace(principal.workspaceId) }),
    },
  },
});
