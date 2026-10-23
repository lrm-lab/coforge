import { createFileRoute } from "@tanstack/react-router";
import { handleAgentAppManagement } from "#src/server/agents/agent-app-management-http.server";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import type { AppUsingAgent } from "#src/server/app-agent-access/agent-app-use.server";
import type { AppAgentManagement } from "#src/server/apps/app-agent-management.server";
import { createAppAgentManagement } from "#src/server/apps/app-agent-management-composition.server";

/** `POST /api/agent/v1/apps/owned/:clientKey/publish-request` (`coforge app request-publish`):
 * files the Marketplace review request and answers the app's publish status. */
export function handleAgentAppPublishRequest(
  request: Request,
  principal: AppUsingAgent,
  clientKey: string,
  management: AppAgentManagement,
): Promise<Response> {
  return handleAgentAppManagement(
    request,
    { operation: "request_publish", clientKey, bodyAs: "none" },
    () => management.requestPublish(principal, clientKey),
  );
}

export const Route = createFileRoute("/api/agent/v1/apps/owned/$clientKey/publish-request")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: ({ request, context: { principal, db }, params }) =>
        handleAgentAppPublishRequest(
          request,
          principal,
          params.clientKey,
          createAppAgentManagement(db),
        ),
    },
  },
});
