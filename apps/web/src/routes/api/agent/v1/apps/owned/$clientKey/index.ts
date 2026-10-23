import { createFileRoute } from "@tanstack/react-router";
import { handleAgentAppManagement } from "#src/server/agents/agent-app-management-http.server";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import type { AppUsingAgent } from "#src/server/app-agent-access/agent-app-use.server";
import type { AppAgentManagement } from "#src/server/apps/app-agent-management.server";
import { createAppAgentManagement } from "#src/server/apps/app-agent-management-composition.server";

/** `PATCH /api/agent/v1/apps/owned/:clientKey` (`coforge app update`): the body is the changed
 * fields; no person approves it. */
export function handleAgentAppUpdate(
  request: Request,
  principal: AppUsingAgent,
  clientKey: string,
  management: AppAgentManagement,
): Promise<Response> {
  return handleAgentAppManagement(
    request,
    { operation: "update", clientKey, bodyAs: "changes" },
    async ({ changes }) => ({ app: await management.update(principal, clientKey, changes) }),
  );
}

/** `DELETE /api/agent/v1/apps/owned/:clientKey` (`coforge app delete`): only an unpublished app. */
export function handleAgentAppDelete(
  request: Request,
  principal: AppUsingAgent,
  clientKey: string,
  management: AppAgentManagement,
): Promise<Response> {
  return handleAgentAppManagement(request, { operation: "delete", clientKey, bodyAs: "none" }, () =>
    management.delete(principal, clientKey),
  );
}

export const Route = createFileRoute("/api/agent/v1/apps/owned/$clientKey/")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      PATCH: ({ request, context: { principal, db }, params }) =>
        handleAgentAppUpdate(request, principal, params.clientKey, createAppAgentManagement(db)),
      DELETE: ({ request, context: { principal, db }, params }) =>
        handleAgentAppDelete(request, principal, params.clientKey, createAppAgentManagement(db)),
    },
  },
});
