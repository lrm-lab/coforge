import { textResponse } from "#src/server/http/text-response.server";
import { createMiddleware } from "@tanstack/react-start";
import type { AgentApiRefusal } from "@lrm/coforge-sdk/agent";
import { APP_ERROR_HTTP_STATUS, isAppError, type AppErrorCode } from "#src/lib/app-error";
import { getDatabaseClient } from "#src/server/db/client.server";
import { RequestAuthenticationError } from "#src/server/errors/request-error-handler.server";
import { AgentMessageValidationError } from "#src/server/conversations/agent-message-validation-error.server";
import { MessageRequestInProgressError } from "#src/server/conversations/message-request-idempotency.server";
import { errorType } from "#src/server/errors/error-type.server";
import { errorResponse } from "./agent-http-error.server";
import { authenticateAgentHttpRequest } from "./agent-api-http.server";
import { authenticateAppBotRequest } from "#src/server/app-bots/app-bot-agent-api.server";
import { createAppBots } from "#src/server/app-bots/app-bots-composition.server";
import { handleWorkspaceAssistantCommand } from "./workspace-assistant-http.server";

/**
 * Authentication boundary for the Agent HTTP API. The daemon presents its own
 * API key plus the Agent's; both must be bound to the same Computer and
 * Workspace. Routes receive the resolved principal and the database it was
 * verified against.
 *
 * Every answer this boundary produces is `cache-control: no-store`: an Agent's
 * view of one Workspace should not be kept by anything between the daemon and
 * us, and a refusal is no different. Two of the routes below
 * (`github-credentials`, `github-commit-trailers`) had set that header
 * themselves and may keep doing so — belt and braces on the routes that carry
 * credentials — but no route has to.
 *
 * The header is applied to a copy rather than by mutating the handler's
 * response. Setting a header on a `Response` is only guaranteed to work while
 * its headers are mutable — Bun is lenient today, stricter runtimes are not —
 * and this code sits inside the `try` above, where a throw would turn a
 * working authenticated request into a 401 "unauthorized". One extra object
 * per request is cheaper than that failure mode.
 */
const NO_STORE = { "cache-control": "no-store" } as const;

const APP_ERROR_REASON: Record<AppErrorCode, string> = {
  INVALID_INPUT: "invalid input",
  NOT_FOUND: "not found",
  ACCESS_DENIED: "forbidden",
  CONFLICT: "conflict",
  TEMPORARILY_UNAVAILABLE: "temporarily unavailable",
  WORKSPACE_REQUIRED: "workspace required",
  INTERNAL_ERROR: "internal error",
  COMPUTER_OFFLINE: "computer is offline",
  COMPUTER_IDENTITY_UNKNOWN: "computer identity unknown",
  RELEASE_FEED_UNAVAILABLE: "release feed unavailable",
  AGENT_NOT_VISIBLE: "not found",
  AGENT_DM_RESTRICTED: "forbidden",
  DM_PEER_NOT_IN_WORKSPACE: "the recipient is not a member of this Workspace",
  AMBIGUOUS_TARGET: "ambiguous target",
  AGENT_DM_CHAIN_LIMIT: "direct message chain limit",
  AGENT_DM_RATE_LIMIT: "rate limited",
  INVALID_TARGET: "invalid target",
  TARGET_NOT_ACCESSIBLE: "target is not accessible",
  PUSH_SERVICE_UNREACHABLE: "push service unreachable",
};

/**
 * Converts one failure at the Agent HTTP boundary into its real status and a stable reason, in
 * the refusal shape (`AgentApiRefusal`) the daemon relays to the Agent — where a refusal is
 * relayable at all: a 401 stays bare "unauthorized" because the daemon treats 401 as the
 * credential boundary's own answer, never a reason; an unknown failure is a logged 500. Routes
 * keep first say: a refusal a route already answers itself never reaches this.
 */
export function agentErrorResponse(error: unknown): Response {
  if (isAppError(error)) {
    const status = APP_ERROR_HTTP_STATUS[error.code];
    const reason = APP_ERROR_REASON[error.code];
    const refusal: AgentApiRefusal = {
      error: `${error.errorId ? `${reason} (${error.errorId})` : reason}${error.hint ? `: ${error.hint}` : ""}`,
      code: error.code,
      // The same request can succeed later only when the failure was temporary.
      retryable: status === 503,
      ...(error.details ? { details: error.details } : {}),
    };
    return Response.json(refusal, { status, headers: NO_STORE });
  }
  if (error instanceof RequestAuthenticationError)
    return textResponse("unauthorized", { status: 401, headers: NO_STORE });
  if (error instanceof AgentMessageValidationError)
    return textResponse(error.message, { status: 400, headers: NO_STORE });
  if (error instanceof MessageRequestInProgressError)
    return noStore(errorResponse("MESSAGE_REQUEST_IN_PROGRESS", error.message, 409, true));
  console.error(
    JSON.stringify({
      event: "agent_http_request_failed",
      errorType: errorType(error),
    }),
  );
  return Response.json({ error: "internal server error" }, { status: 500, headers: NO_STORE });
}

export function noStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export const agentAuthMiddleware = createMiddleware().server(async ({ next, request }) => {
  const db = getDatabaseClient();
  if (!db) return textResponse("unauthorized", { status: 401, headers: NO_STORE });
  try {
    // An app's bot presents its key alone and has no Computer; its calls are bounded by capability.
    const bot = await authenticateAppBotRequest(request, createAppBots(db));
    if (bot instanceof Response) return noStore(bot);
    if (bot) {
      const result = await next({ context: { principal: bot.principal, db } });
      result.response = noStore(result.response);
      return result;
    }
    const principal = await authenticateAgentHttpRequest(request, db);
    const delegated = await handleWorkspaceAssistantCommand(request, principal, db);
    if (delegated) return noStore(delegated);
    const result = await next({ context: { principal, db } });
    result.response = noStore(result.response);
    return result;
  } catch (error) {
    return agentErrorResponse(error);
  }
});
