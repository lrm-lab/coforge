import { decodeAgentArtifactRequest } from "@lrm/coforge-sdk/agent";
import { createFileRoute } from "@tanstack/react-router";
import { AppError } from "#src/lib/app-error";
import {
  agentAuthMiddleware,
  agentErrorResponse,
} from "#src/server/agents/agent-http-middleware.server";
import { agentChannelReader } from "#src/server/agents/workspace-assistant-authority.server";
import {
  ArtifactRateLimited,
  runAgentArtifactOperation,
  type AgentArtifactServices,
} from "#src/server/artifacts/agent-artifacts.server";
import { artifactsEnabled } from "#src/server/artifacts/artifact-access.server";
import {
  productionArtifactAttachments,
  productionArtifactNotices,
  productionArtifactSignals,
  productionArtifacts,
} from "#src/server/artifacts/artifact-composition.server";
import { getAppRateLimits } from "#src/server/app-rate-limits/app-rate-limits-composition.server";
import { artifactApplicationOrigin } from "#src/server/artifacts/artifact-sandbox-config.server";
import {
  centrifugoServerApiConfigured,
  createCentrifugoServerApi,
} from "#src/server/centrifugo/server-api.server";

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
    if (error instanceof ArtifactRateLimited) return error.response();
    return agentErrorResponse(error);
  }
}

export const Route = createFileRoute("/api/agent/v1/artifacts")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: async ({ request, context: { principal, db } }) => {
        const { documents, blobs } = productionArtifacts(db);
        const requestOrigin = () => {
          const configured = artifactApplicationOrigin();
          if (configured) return configured;
          try {
            return new URL(request.url).origin;
          } catch {
            return null;
          }
        };
        const presence = centrifugoServerApiConfigured()
          ? (channel: string) => createCentrifugoServerApi().presence(channel)
          : undefined;
        const readActor = await agentChannelReader(db, principal.workspaceId, principal.agentId);
        return handleAgentArtifactPost(request, principal, {
          db,
          documents,
          blobs,
          enabled: (workspaceId) => artifactsEnabled(db, workspaceId),
          notices: productionArtifactNotices(db),
          signals: productionArtifactSignals(),
          attachments: productionArtifactAttachments(db),
          writeLimit: getAppRateLimits().artifactWrite,
          appOrigin: requestOrigin,
          presence,
          readActor,
        });
      },
    },
  },
});
