/** The scope a local Agent context query must prove before touching the index or provider files. */
export type AgentContextSessionScope = Readonly<{
  /** Agent resolved from the loopback proxy's token binding. */
  authorizedAgentId: string;
  /** Agent named by the request payload. */
  requestedAgentId: string;
  /** Session the caller wants to inspect. */
  requestedSessionId: string;
  /** Session currently held by the token-bound Agent process. */
  currentSessionId: string | undefined;
}>;

export type AgentContextSessionAuthorizationFailure =
  | "agent_mismatch"
  | "session_unavailable"
  | "session_mismatch";

export type AgentContextSessionAuthorization =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: AgentContextSessionAuthorizationFailure }>;

/**
 * Authorizes a context query without consulting the transcript index.
 *
 * The local proxy already binds the credential to an Agent. The requested Agent and session are
 * checked again here so a caller cannot turn a valid local token into a cross-Agent or stale-
 * session read. Keeping this pure makes the ordering easy to test: callers must run it before
 * `ContextViewStore.find`, source resolution, or child restore.
 */
export function authorizeAgentContextSession(
  scope: AgentContextSessionScope,
): AgentContextSessionAuthorization {
  if (scope.requestedAgentId !== scope.authorizedAgentId)
    return { ok: false, reason: "agent_mismatch" };
  if (scope.currentSessionId === undefined || scope.currentSessionId.length === 0)
    return { ok: false, reason: "session_unavailable" };
  if (scope.requestedSessionId !== scope.currentSessionId)
    return { ok: false, reason: "session_mismatch" };
  return { ok: true };
}
