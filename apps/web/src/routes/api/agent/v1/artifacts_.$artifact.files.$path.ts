import { createFileRoute } from "@tanstack/react-router";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import { agentChannelReader } from "#src/server/agents/workspace-assistant-authority.server";
import { handleAgentArtifactDownload } from "#src/server/artifacts/agent-artifact-files.server";
import { artifactsEnabled } from "#src/server/artifacts/artifact-access.server";
import { productionArtifacts } from "#src/server/artifacts/artifact-composition.server";

export const Route = createFileRoute("/api/agent/v1/artifacts_/$artifact/files/$path")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      GET: async ({ request, params, context: { principal, db } }) =>
        handleAgentArtifactDownload(request, params, principal, {
          ...productionArtifacts(db),
          enabled: (workspaceId) => artifactsEnabled(db, workspaceId),
          readActor: await agentChannelReader(db, principal.workspaceId, principal.agentId),
        }),
    },
  },
});
