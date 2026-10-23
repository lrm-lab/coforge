import { createFileRoute } from "@tanstack/react-router";
import { handleAgentAppManagement } from "#src/server/agents/agent-app-management-http.server";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import type { AppUsingAgent } from "#src/server/app-agent-access/agent-app-use.server";
import type { AppAgentManagement } from "#src/server/apps/app-agent-management.server";
import { createAppAgentManagement } from "#src/server/apps/app-agent-management-composition.server";

/** `POST /api/agent/v1/apps/owned/:clientKey/rotate-secret` (`coforge app rotate-secret`): a new
 * client secret for an app this Agent manages, in the response body only (never cached). */
export function handleAgentAppRotateSecret(
  request: Request,
  principal: AppUsingAgent,
  clientKey: string,
  management: AppAgentManagement,
): Promise<Response> {
  return handleAgentAppManagement(
    request,
    { operation: "rotate_secret", clientKey, bodyAs: "none" },
    () => management.rotateSecret(principal, clientKey),
  );
}

export const Route = createFileRoute("/api/agent/v1/apps/owned/$clientKey/rotate-secret")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: ({ request, context: { principal, db }, params }) =>
        handleAgentAppRotateSecret(
          request,
          principal,
          params.clientKey,
          createAppAgentManagement(db),
        ),
    },
  },
});
