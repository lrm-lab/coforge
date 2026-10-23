import { createFileRoute } from "@tanstack/react-router";
import { handleAgentAppManagement } from "#src/server/agents/agent-app-management-http.server";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import type { AppUsingAgent } from "#src/server/app-agent-access/agent-app-use.server";
import type { AppAgentManagement } from "#src/server/apps/app-agent-management.server";
import { createAppAgentManagement } from "#src/server/apps/app-agent-management-composition.server";
import { publicOrigin } from "#src/server/http/public-origin.server";

/** `POST /api/agent/v1/apps/owned/:clientKey/share-link` (`coforge app share-link`):
 * `{ expiresDays }` from 1 to 365. The URL is in this answer and nowhere else. */
export function handleAgentAppShareLinkCreate(
  request: Request,
  principal: AppUsingAgent,
  clientKey: string,
  management: AppAgentManagement,
): Promise<Response> {
  return handleAgentAppManagement(
    request,
    { operation: "share_link_create", clientKey, bodyAs: "fields" },
    ({ expiresDays }) =>
      management.createShareLink(principal, clientKey, {
        expiresDays,
        origin: publicOrigin(request),
      }),
  );
}

/** `GET .../share-link` (`coforge app share-link-status`): when the active link ends. */
export function handleAgentAppShareLinkStatus(
  request: Request,
  principal: AppUsingAgent,
  clientKey: string,
  management: AppAgentManagement,
): Promise<Response> {
  return handleAgentAppManagement(
    request,
    { operation: "share_link_status", clientKey, bodyAs: "none" },
    () => management.shareLinkStatus(principal, clientKey),
  );
}

/** `DELETE .../share-link` (`coforge app revoke-share-link`). */
export function handleAgentAppShareLinkRevoke(
  request: Request,
  principal: AppUsingAgent,
  clientKey: string,
  management: AppAgentManagement,
): Promise<Response> {
  return handleAgentAppManagement(
    request,
    { operation: "share_link_revoke", clientKey, bodyAs: "none" },
    () => management.revokeShareLink(principal, clientKey),
  );
}

export const Route = createFileRoute("/api/agent/v1/apps/owned/$clientKey/share-link")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: ({ request, context: { principal, db }, params }) =>
        handleAgentAppShareLinkCreate(
          request,
          principal,
          params.clientKey,
          createAppAgentManagement(db),
        ),
      GET: ({ request, context: { principal, db }, params }) =>
        handleAgentAppShareLinkStatus(
          request,
          principal,
          params.clientKey,
          createAppAgentManagement(db),
        ),
      DELETE: ({ request, context: { principal, db }, params }) =>
        handleAgentAppShareLinkRevoke(
          request,
          principal,
          params.clientKey,
          createAppAgentManagement(db),
        ),
    },
  },
});
