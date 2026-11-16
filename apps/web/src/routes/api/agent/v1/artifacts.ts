import { decodeAgentArtifactRequest } from "@lrm/coforge-sdk/agent";
import { createFileRoute } from "@tanstack/react-router";
import { AppError } from "#src/lib/app-error";
import {
  agentAuthMiddleware,
  agentErrorResponse,
} from "#src/server/agents/agent-http-middleware.server";
import {
  runAgentArtifactOperation,
  type AgentArtifactServices,
} from "#src/server/artifacts/agent-artifacts.server";
import { artifactsEnabled } from "#src/server/artifacts/artifact-access.server";
import {
  productionArtifactNotices,
  productionArtifacts,
} from "#src/server/artifacts/artifact-composition.server";

export async function handleAgentArtifactPost(
  request: Request,
  principal: { workspaceId: string; agentId: string },
  services: AgentArtifactServices,
): Promise<Response> {
  try {
    const body = decodeAgentArtifactRequest(await request.json().catch(() => null));
    if (!body) throw new AppError("INVALID_INPUT", { errorId: "artifact-request" });
    return Response.json(await runAgentArtifactOperation(services, principal, body));
  } catch (error) {
    return agentErrorResponse(error);
  }
}

export const Route = createFileRoute("/api/agent/v1/artifacts")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: ({ request, context: { principal, db } }) =>
        handleAgentArtifactPost(request, principal, {
          db,
          documents: productionArtifacts(db).documents,
          enabled: (workspaceId) => artifactsEnabled(db, workspaceId),
          notices: productionArtifactNotices(db),
        }),
    },
  },
});
