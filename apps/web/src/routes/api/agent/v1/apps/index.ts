import { createFileRoute } from "@tanstack/react-router";
import type { AgentAppListResponse } from "@lrm/coforge-sdk/agent";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import type { AgentAppUse, AppUsingAgent } from "#src/server/app-agent-access/agent-app-use.server";
import { createAgentAppUse } from "#src/server/app-agent-access/app-agent-access-composition.server";
import { agentAppServiceRefusal } from "#src/server/agents/agent-app-refusals.server";

/** `GET /api/agent/v1/apps` (`coforge app list`): the apps of the calling Agent's Workspace, with
 * its access to each, and the built-in Agent Apps. */
export async function handleAgentAppList(
  principal: AppUsingAgent,
  apps: Pick<AgentAppUse, "list">,
): Promise<Response> {
  try {
    const body: AgentAppListResponse = { ok: true, apps: await apps.list(principal) };
    return Response.json(body);
  } catch (error) {
    return agentAppServiceRefusal(error);
  }
}

export const Route = createFileRoute("/api/agent/v1/apps/")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      GET: ({ context: { principal, db } }) => handleAgentAppList(principal, createAgentAppUse(db)),
    },
  },
});
