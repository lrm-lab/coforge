/**
 * `AgentControl`'s fixed rejection messages (agent-runtime/agent-control.ts). They are stable,
 * low-cardinality identifiers, safe to log verbatim as `control_code` — unlike an arbitrary error
 * message, which `diagnosticErrorCode` deliberately never logs raw.
 */
const CONTROL_ERROR_CODES = new Set([
  "previous_control_not_completed",
  "previous_process_stop_unconfirmed",
  "stale_control_request",
  "control_request_mismatch",
  "control_record_missing",
  "control_epoch_required",
  "agent_already_running",
  "confirmed_stop_required",
  // The server mints and supplies launchId for every managed start; a managed
  // intent that somehow arrives without one is a protocol bug, not a normal race.
  "agent_launch_id_required",
]);

/** `{ control_code }` when `error` is one of AgentControl's fixed rejection messages, else `{}`. */
export function controlCodeField(error: unknown): { control_code: string } | Record<string, never> {
  const message = error instanceof Error ? error.message : undefined;
  return message !== undefined && CONTROL_ERROR_CODES.has(message) ? { control_code: message } : {};
}
