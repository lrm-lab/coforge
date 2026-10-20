import { createFileRoute } from "@tanstack/react-router";
import { decodeAgentAppTokenBody, type AgentAppTokenResponse } from "@lrm/coforge-sdk/agent";
import type { AppErrorCode } from "#src/lib/app-error";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import { readAgentJsonBody } from "#src/server/agents/agent-http-routes.server";
import type {
  AgentAppTokenOutcome,
  AgentAppUse,
  AppUsingAgent,
} from "#src/server/app-agent-access/agent-app-use.server";
import { createAgentAppUse } from "#src/server/app-agent-access/app-agent-access-composition.server";
import {
  agentAppRefusal,
  agentAppServiceRefusal,
} from "#src/server/agents/agent-app-refusals.server";

const answer = (body: AgentAppTokenResponse) => Response.json(body);

/** Why an approval card cannot be posted to `target`, by the refusal `message send` gives. */
function targetRefusal(code: AppErrorCode, target: string, requestId: string): string {
  const why =
    code === "ACCESS_DENIED"
      ? `you are not a member of ${target}`
      : code === "INVALID_INPUT"
        ? `${target} is not a #channel[:thread] or @user[:thread] target`
        : `${target} was not found`;
  return `The approval card could not be posted: ${why}. The request ${requestId} still waits for a person; run again with a target you can post to.`;
}

/** `POST /api/agent/v1/apps/:appKey/token` (`coforge app token`): a five-minute token for one of
 * the Workspace's apps, or what the Agent must wait for instead. */
export async function handleAgentAppToken(
  request: Request,
  principal: AppUsingAgent,
  appKey: string,
  apps: Pick<AgentAppUse, "token">,
): Promise<Response> {
  const body = decodeAgentAppTokenBody(await readAgentJsonBody(request));
  if (!body)
    return agentAppRefusal("request_invalid", "The body must be { target? } with nothing else.");
  let outcome: AgentAppTokenOutcome;
  try {
    outcome = await apps.token(principal, appKey, { target: body.target });
  } catch (error) {
    return agentAppServiceRefusal(error);
  }
  switch (outcome.status) {
    case "issued":
      return answer({
        ok: true,
        status: "issued",
        access_token: outcome.accessToken,
        token_type: "Bearer",
        expires_in: outcome.expiresIn,
        audience: outcome.audience,
        scope: outcome.scope,
      });
    case "approval_required":
    case "not_installed":
      return answer({ ok: true, ...outcome });
    case "unavailable":
      return agentAppRefusal(
        "app_tokens_unavailable",
        "This CoForge server has no Login with CoForge authorization server, so it issues no app tokens.",
      );
    case "target_refused":
      return agentAppRefusal(
        "target_invalid",
        targetRefusal(outcome.code, body.target ?? "", outcome.requestId),
      );
  }
}

export const Route = createFileRoute("/api/agent/v1/apps/$appId/token")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: ({ request, context: { principal, db }, params }) =>
        handleAgentAppToken(request, principal, params.appId, createAgentAppUse(db)),
    },
  },
});
