import { createFileRoute } from "@tanstack/react-router";
import {
  APP_REGISTRATION_ID_MAX_LENGTH,
  type AppRegistrationStatusResponse,
} from "@lrm/coforge-sdk/agent";
import {
  agentAppOwnerRefusal,
  agentAppRefusal,
} from "#src/server/agents/agent-app-refusals.server";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import type { AppUsingAgent } from "#src/server/app-agent-access/agent-app-use.server";
import type { AppOwnerAgents } from "#src/server/apps/app-owner-agents.server";
import { createAppOwnerAgents } from "#src/server/apps/app-owner-agents-composition.server";

/** `GET /api/agent/v1/apps/registrations/status?card=<id>|client=<key>` (`coforge app status`):
 * where one of the Agent's register cards, or one app it manages, stands. */
export async function handleAgentAppRegistrationStatus(
  request: Request,
  principal: AppUsingAgent,
  owners: Pick<AppOwnerAgents, "status">,
): Promise<Response> {
  const query = new URL(request.url).searchParams;
  const card = query.get("card") ?? undefined;
  const client = query.get("client") ?? undefined;
  if (!card === !client || (card ?? client)!.length > APP_REGISTRATION_ID_MAX_LENGTH)
    return agentAppRefusal("request_invalid", "Name exactly one of card and client.");
  try {
    const body: AppRegistrationStatusResponse = {
      ok: true,
      ...(await owners.status(principal, { card, client })),
    };
    return Response.json(body);
  } catch (error) {
    return agentAppOwnerRefusal(error);
  }
}

export const Route = createFileRoute("/api/agent/v1/apps/registrations/status")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      GET: ({ request, context: { principal, db } }) =>
        handleAgentAppRegistrationStatus(request, principal, createAppOwnerAgents(db)),
    },
  },
});
