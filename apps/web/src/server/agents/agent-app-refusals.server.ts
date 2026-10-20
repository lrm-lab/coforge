import type { AgentAppErrorCode, AgentAppErrorResponse } from "@lrm/coforge-sdk/agent";
import { isAppErrorCode } from "#src/lib/app-error";

/** The HTTP status of each refusal the Agent app routes (`coforge app list|token`) answer. */
const STATUS: Record<AgentAppErrorCode, number> = {
  app_tokens_unavailable: 503,
  request_invalid: 400,
  target_invalid: 422,
  not_found: 404,
  conflict: 409,
  invalid_input: 400,
  access_denied: 403,
};

/** A refusal as the Agent routes answer one: `{ ok: false, errorCode, error }`. */
export function agentAppRefusal(errorCode: AgentAppErrorCode, error: string): Response {
  const body: AgentAppErrorResponse = { ok: false, errorCode, error };
  return Response.json(body, { status: STATUS[errorCode] });
}

/** The refusal for an `AppError` the app services raise; anything else is rethrown. */
export function agentAppServiceRefusal(error: unknown): Response {
  if (isAppErrorCode(error, "NOT_FOUND"))
    return agentAppRefusal("not_found", "The calling Agent is no longer in its Workspace.");
  if (isAppErrorCode(error, "CONFLICT"))
    return agentAppRefusal(
      "conflict",
      "Another use of this app changed the Agent's access at the same time.",
    );
  if (isAppErrorCode(error, "INVALID_INPUT"))
    return agentAppRefusal("invalid_input", "The app does not allow what was asked for.");
  if (isAppErrorCode(error, "ACCESS_DENIED"))
    return agentAppRefusal("access_denied", "The Agent may not use the app this way.");
  throw error;
}
