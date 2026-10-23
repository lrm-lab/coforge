import { createFileRoute } from "@tanstack/react-router";
import type { AppOwnedListResponse } from "@lrm/coforge-sdk/agent";
import { agentAppOwnerRefusal } from "#src/server/agents/agent-app-refusals.server";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import type { AppUsingAgent } from "#src/server/app-agent-access/agent-app-use.server";
import type { AppOwnerAgents } from "#src/server/apps/app-owner-agents.server";
import { createAppOwnerAgents } from "#src/server/apps/app-owner-agents-composition.server";

/** `GET /api/agent/v1/apps/owned` (`coforge app list --owned`): the Agent's waiting register cards
 * and the apps it owns (an admin Agent also sees every app of its Workspace). */
export async function handleAgentAppOwned(
  principal: AppUsingAgent,
  owners: Pick<AppOwnerAgents, "list">,
): Promise<Response> {
  try {
    const body: AppOwnedListResponse = { ok: true, ...(await owners.list(principal)) };
    return Response.json(body);
  } catch (error) {
    return agentAppOwnerRefusal(error);
  }
}

export const Route = createFileRoute("/api/agent/v1/apps/owned/")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      GET: ({ context: { principal, db } }) =>
        handleAgentAppOwned(principal, createAppOwnerAgents(db)),
    },
  },
});
