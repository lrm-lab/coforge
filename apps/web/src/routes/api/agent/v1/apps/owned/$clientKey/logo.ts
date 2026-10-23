import { createFileRoute } from "@tanstack/react-router";
import { handleAgentAppManagement } from "#src/server/agents/agent-app-management-http.server";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import type { AppUsingAgent } from "#src/server/app-agent-access/agent-app-use.server";
import type { AppAgentManagement } from "#src/server/apps/app-agent-management.server";
import { createAppAgentManagement } from "#src/server/apps/app-agent-management-composition.server";

/** `PUT /api/agent/v1/apps/owned/:clientKey/logo` (`coforge app logo`): `{ contentType,
 * dataBase64 }`, a PNG, JPEG, GIF or WebP of at most 5 MB. */
export function handleAgentAppLogoSet(
  request: Request,
  principal: AppUsingAgent,
  clientKey: string,
  management: AppAgentManagement,
): Promise<Response> {
  return handleAgentAppManagement(
    request,
    { operation: "logo_set", clientKey, bodyAs: "fields" },
    async ({ contentType, dataBase64 }) => ({
      app: await management.setLogo(principal, clientKey, { contentType, dataBase64 }),
    }),
  );
}

/** `DELETE /api/agent/v1/apps/owned/:clientKey/logo` (`coforge app clear-logo`). */
export function handleAgentAppLogoClear(
  request: Request,
  principal: AppUsingAgent,
  clientKey: string,
  management: AppAgentManagement,
): Promise<Response> {
  return handleAgentAppManagement(
    request,
    { operation: "logo_clear", clientKey, bodyAs: "none" },
    async () => ({ app: await management.clearLogo(principal, clientKey) }),
  );
}

export const Route = createFileRoute("/api/agent/v1/apps/owned/$clientKey/logo")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      PUT: ({ request, context: { principal, db }, params }) =>
        handleAgentAppLogoSet(request, principal, params.clientKey, createAppAgentManagement(db)),
      DELETE: ({ request, context: { principal, db }, params }) =>
        handleAgentAppLogoClear(request, principal, params.clientKey, createAppAgentManagement(db)),
    },
  },
});
