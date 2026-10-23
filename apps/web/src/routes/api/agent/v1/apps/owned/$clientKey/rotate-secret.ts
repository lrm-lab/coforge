import { createFileRoute } from "@tanstack/react-router";
import type { AppSecretRotationResponse } from "@lrm/coforge-sdk/agent";
import { agentAppOwnerRefusal } from "#src/server/agents/agent-app-refusals.server";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import type { AppUsingAgent } from "#src/server/app-agent-access/agent-app-use.server";
import type { AppOwnerAgents } from "#src/server/apps/app-owner-agents.server";
import { createAppOwnerAgents } from "#src/server/apps/app-owner-agents-composition.server";

/** `POST /api/agent/v1/apps/owned/:clientKey/rotate-secret` (`coforge app rotate-secret`): a new
 * client secret for an app this Agent owns, in the response body only. */
export async function handleAgentAppRotateSecret(
  principal: AppUsingAgent,
  clientKey: string,
  owners: Pick<AppOwnerAgents, "rotateSecret">,
): Promise<Response> {
  try {
    const body: AppSecretRotationResponse = {
      ok: true,
      ...(await owners.rotateSecret(principal, clientKey)),
    };
    return Response.json(body, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return agentAppOwnerRefusal(error);
  }
}

export const Route = createFileRoute("/api/agent/v1/apps/owned/$clientKey/rotate-secret")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: ({ context: { principal, db }, params }) =>
        handleAgentAppRotateSecret(principal, params.clientKey, createAppOwnerAgents(db)),
    },
  },
});
