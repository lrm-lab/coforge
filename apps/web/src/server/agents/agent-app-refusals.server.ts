import type { AgentAppErrorCode, AgentAppErrorResponse } from "@lrm/coforge-sdk/agent";
import { isAppErrorCode } from "#src/lib/app-error";
import { AppScopeNotAllowedError } from "#src/server/app-agent-access/access-rules.server";

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
  if (error instanceof AppScopeNotAllowedError)
    return agentAppRefusal(
      "invalid_input",
      `The app does not allow the scope${error.scopes.length === 1 ? "" : "s"} ${error.scopes.join(", ")}: it is not among the scopes the app is allowed to ask for.`,
    );
  if (isAppErrorCode(error, "INVALID_INPUT"))
    return agentAppRefusal("invalid_input", "The app does not allow what was asked for.");
  if (isAppErrorCode(error, "ACCESS_DENIED"))
    return agentAppRefusal("access_denied", "The Agent may not use the app this way.");
  throw error;
}

/** What each errorId an Agent's management of its apps raises means for the Agent; the message
 * names the fix. */
const MANAGEMENT_MESSAGES: Record<string, string> = {
  "app-published-undeletable":
    "The app is published or waiting to leave the Marketplace, so it cannot be deleted. Ask for its removal (request-unpublish) and delete it once it is private.",
  "app-share-status-conflict":
    "Only a private or rejected app has a share link; this app is published or waiting for review.",
  "app-share-expiry-invalid": "--expires-days takes a whole number from 1 to 365.",
  "app-publish-status-conflict": "The app's publish status does not allow this request.",
  "app-description-required":
    "A publish request needs the app to have a description: set one with app update --description.",
  "app-marketplace-off": "The Marketplace is not available in this Workspace.",
  "app-agent-manifest-off": "The Agent manifest URL is not available in this Workspace.",
  "app-redirect-uris-invalid":
    "The redirect URLs are not acceptable. They cannot be cleared; give one or more valid URLs.",
  "app-owner-agent-invalid":
    "That Agent is not a live, public Agent of this Workspace, so it cannot own the app.",
};

/** The refusal for an `AppError` raised while an Agent manages the apps it registered (`coforge
 * app status|list --owned|rotate-secret|update|logo|clear-logo|transfer-owner|delete|share-link|
 * request-publish|...`); anything else is rethrown. */
export function agentAppOwnerRefusal(error: unknown): Response {
  if (isAppErrorCode(error, "NOT_FOUND"))
    return agentAppRefusal(
      "not_found",
      "No such card or app is managed by this Agent: it may not exist, belong to another Workspace, or be one this Agent is neither the owner Agent of nor an admin Agent for; or this Agent may be archived.",
    );
  const known = isAppErrorCode(error, "CONFLICT", "INVALID_INPUT", "ACCESS_DENIED")
    ? error
    : undefined;
  if (known) {
    const detail = known.errorId ? MANAGEMENT_MESSAGES[known.errorId] : undefined;
    if (known.code === "CONFLICT")
      return agentAppRefusal(
        "conflict",
        detail ?? "The app changed at the same time; nothing was changed.",
      );
    if (known.code === "ACCESS_DENIED")
      return agentAppRefusal("access_denied", detail ?? "This Agent may not do that.");
    return agentAppRefusal(
      "invalid_input",
      detail ?? `A value was not acceptable${known.errorId ? ` (${known.errorId})` : ""}.`,
    );
  }
  throw error;
}
