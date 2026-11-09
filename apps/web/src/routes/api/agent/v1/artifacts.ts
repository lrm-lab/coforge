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
import { productionArtifacts } from "#src/server/artifacts/artifact-composition.server";
import { ArtifactShares } from "#src/server/artifacts/artifact-shares.server";
import { isFeatureEnabled } from "#src/server/feature-flags/feature-flags.server";
import { agentMessagesPostDependencies } from "./messages";

/**
 * `coforge artifact create|read|push|history|revert` (task #385): one operation per request, as
 * JSON. A body that is not one known operation with exactly its own fields is `INVALID_INPUT`, so
 * a save's internal options can never be sent; every refusal is the Agent API's (`code`, and the
 * `errorId` in `error`).
 */
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
      POST: ({ request, context: { principal, db } }) => {
        const messageDependencies = agentMessagesPostDependencies(db);
        return handleAgentArtifactPost(request, principal, {
          db,
          ...productionArtifacts(db),
          shares: new ArtifactShares(db, (workspaceId) => artifactsEnabled(db, workspaceId)),
          send: ({ target, idempotencyKey, body }) =>
            messageDependencies.sender.executeFromAgent({
              workspaceId: principal.workspaceId,
              agentId: principal.agentId,
              target,
              idempotencyKey,
              body,
            }),
          enabled: (workspaceId) => artifactsEnabled(db, workspaceId),
          webPages: (workspaceId) => isFeatureEnabled("artifact-web-pages", { workspaceId }),
        });
      },
    },
  },
});
