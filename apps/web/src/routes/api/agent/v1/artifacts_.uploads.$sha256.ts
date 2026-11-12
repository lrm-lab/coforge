import { createFileRoute } from "@tanstack/react-router";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import { handleAgentArtifactUpload } from "#src/server/artifacts/agent-artifact-files.server";
import { artifactsEnabled } from "#src/server/artifacts/artifact-access.server";
import { productionArtifacts } from "#src/server/artifacts/artifact-composition.server";

/** `coforge artifact push`'s file bytes, one `PUT` per file by sha256, before the push names it. */
export const Route = createFileRoute("/api/agent/v1/artifacts_/uploads/$sha256")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      PUT: ({ request, params, context: { principal, db } }) =>
        handleAgentArtifactUpload(request, params.sha256, principal, {
          ...productionArtifacts(db),
          enabled: (workspaceId) => artifactsEnabled(db, workspaceId),
        }),
    },
  },
});
