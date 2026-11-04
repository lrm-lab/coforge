import { createFileRoute } from "@tanstack/react-router";
import { decodeAgentLabelWriteRequest, type AgentLabelListResponse } from "@lrm/coforge-sdk/agent";
import { AppError } from "#src/lib/app-error";
import {
  agentAuthMiddleware,
  agentErrorResponse,
} from "#src/server/agents/agent-http-middleware.server";
import {
  productionAgentLabelWrites,
  runAgentLabelWrite,
  type AgentLabelWriteServices,
} from "#src/server/tasks/agent-label-writes.server";
import { Labels } from "#src/server/tasks/labels.server";

/**
 * `coforge label create|rename|update|delete|restore` (task #508): one label write per request. A
 * body that is not one known operation with exactly its own fields is `INVALID_INPUT`.
 */
export async function handleAgentLabelPost(
  request: Request,
  principal: { workspaceId: string; agentId: string },
  services: AgentLabelWriteServices,
): Promise<Response> {
  try {
    const body = decodeAgentLabelWriteRequest(await request.json().catch(() => null));
    if (!body) throw new AppError("INVALID_INPUT", { errorId: "label-write-request" });
    return Response.json(await runAgentLabelWrite(services, principal, body));
  } catch (error) {
    return agentErrorResponse(error);
  }
}

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
      POST: ({ request, context: { principal, db } }) =>
        handleAgentLabelPost(request, principal, productionAgentLabelWrites(db)),
    },
  },
});
