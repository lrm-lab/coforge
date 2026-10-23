import { createFileRoute } from "@tanstack/react-router";
import { handleAgentAppManagement } from "#src/server/agents/agent-app-management-http.server";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import type { AppUsingAgent } from "#src/server/app-agent-access/agent-app-use.server";
import type { AppAgentManagement } from "#src/server/apps/app-agent-management.server";
import { createAppAgentManagement } from "#src/server/apps/app-agent-management-composition.server";

/** `POST /api/agent/v1/apps/owned/:clientKey/transfer-owner` (`coforge app transfer-owner`):
 * `{ toAgent }`, another live Agent of the Workspace; answers the receipt. */
export function handleAgentAppTransferOwner(
  request: Request,
  principal: AppUsingAgent,
  clientKey: string,
  management: AppAgentManagement,
): Promise<Response> {
  return handleAgentAppManagement(
    request,
    { operation: "transfer_owner", clientKey, bodyAs: "fields" },
    ({ toAgent }) => management.transferOwner(principal, clientKey, toAgent),
  );
}

export const Route = createFileRoute("/api/agent/v1/apps/owned/$clientKey/transfer-owner")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: ({ request, context: { principal, db }, params }) =>
        handleAgentAppTransferOwner(
          request,
          principal,
          params.clientKey,
          createAppAgentManagement(db),
        ),
    },
  },
});
