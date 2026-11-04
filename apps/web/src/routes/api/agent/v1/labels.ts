import { createFileRoute } from "@tanstack/react-router";
import type { AgentLabelListResponse } from "@lrm/coforge-sdk/agent";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import { Labels } from "#src/server/tasks/labels.server";

/** `coforge label list`: the Workspace's labels with their group, counts and last use. */
export const Route = createFileRoute("/api/agent/v1/labels")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      GET: async ({ context: { principal, db } }) => {
        const labels = await new Labels(db).listForWorkspace(principal.workspaceId, {
          archived: true,
        });
        const body: AgentLabelListResponse = {
          ok: true,
          labels: labels.map((label) => ({
            ...label,
            archivedAt: label.archivedAt?.toISOString() ?? null,
          })),
        };
        return Response.json(body);
      },
    },
  },
});
