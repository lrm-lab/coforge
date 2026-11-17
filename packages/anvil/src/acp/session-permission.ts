import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";

/**
 * Answers an ACP `session/request_permission` request for a session.
 * Grants `allow_once` only when the session is live and the request targets its own session id;
 * otherwise cancels so disposed, failed, interrupting, or foreign-session requests never run.
 */
export function resolveAcpPermission(request: RequestPermissionRequest, live: boolean) {
  const allow = live ? request.options.find((option) => option.kind === "allow_once") : undefined;
  return {
    outcome: allow
      ? { outcome: "selected" as const, optionId: allow.optionId }
      : { outcome: "cancelled" as const },
  };
}
