import { createFileRoute } from "@tanstack/react-router";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import { errorResponse } from "#src/server/agents/agent-http-error.server";
import { PrismaExternalAgentCredentialRepository } from "#src/server/db/repositories/external-agent-credential.repositories.server";
import { syncExternalPresenceBestEffort } from "#src/server/agents/external-agent-presence-publish.server";
import {
  isExternalAgentPrincipal,
  revokeSelfExternalCredential,
} from "#src/server/agents/external-agent-credentials.server";

export const Route = createFileRoute("/api/agent/v1/credentials/self/revoke")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: async ({ context: { principal, db } }) => {
        if (!isExternalAgentPrincipal(principal))
          return errorResponse(
            "credential_not_self_revocable",
            "this credential is not revocable by the Agent",
            403,
            false,
          );
        const revoked = await revokeSelfExternalCredential(
          new PrismaExternalAgentCredentialRepository(db),
          principal,
        );
        if (revoked) await syncExternalPresenceBestEffort(db, principal);
        return Response.json({ state: "revoked" });
      },
    },
  },
});
