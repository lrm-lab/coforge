/**
 * What a stopped Agent needs before it works again, by the stop reason the cloud display keeps
 * (`AgentDisplaySnapshot.stopReason`): a launch failure's code (the Daemon's
 * `LAUNCH_FAILURE_REASON`) or a runtime failure's `errorReason` (its runtime error rules), task
 * #731. Defined beside the vocabulary rather than in the web app, so a reason the Daemon adds is
 * classified where it is added: the Daemon's test fails for any reason missing here.
 *
 * - `retry`: only a person clears the cause (signs in, installs, fixes a setting); then Start.
 * - `reset_session`: the conversation itself is the cause (too long to send); Start again would
 *   fail the same way, a fresh session does not.
 * - `automatic`: the Daemon retries on its own (a rate limit, a provider hiccup, a quota window).
 */
export const STOP_RECOVERY = {
  RETRY: "retry",
  RESET_SESSION: "reset_session",
  AUTOMATIC: "automatic",
} as const;
export type StopRecovery = (typeof STOP_RECOVERY)[keyof typeof STOP_RECOVERY];

const { RETRY, RESET_SESSION, AUTOMATIC } = STOP_RECOVERY;

export const STOP_REASON_RECOVERY: Readonly<Record<string, StopRecovery>> = {
  // Launch failures: the non-retryable ones wait for a person at once, the rest once the
  // Daemon's attempts run out (the server then records the code).
  agent_authorization_failed: RETRY,
  runtime_private: RETRY,
  runtime_not_installed: RETRY,
  runtime_unusable: RETRY,
  runtime_unavailable: RETRY,
  runtime_not_found: RETRY,
  runtime_version_too_old: RETRY,
  runtime_start_failed: RETRY,
  runtime_login_required: RETRY,
  model_not_found: RETRY,
  model_provider_not_configured: RETRY,
  agent_environment_invalid: RETRY,
  runtime_memory_unsupported: RETRY,
  runtime_spawn_failed: RETRY,
  // The wakes outlived their deadline: nothing starts it again until a person does (task #33).
  startup_deadline_exceeded: RETRY,
  // Runtime failures that end the process.
  launcher_error: RETRY,
  input_too_large: RESET_SESSION,
  billing_exhausted: RETRY,
  auth_failed: RETRY,
  model_config_error: RETRY,
  runtime_failure: RETRY,
  stalled_restart_limit: RETRY,
  // A fence (the same failure repeating with no progress) or an unresolved crash leaves nothing to
  // solve on this side: the reference Computer ends the fence with "Restart after the runtime/tooling
  // issue is fixed", so the person clears that cause and starts the Agent again (task #5).
  runtime_error_fenced: RETRY,
  runtime_crashed: RETRY,
  // Runtime failures the Daemon recovers from by itself.
  // A provider that hung is killed and restarted, and the next turn may simply work: nothing
  // here is a person's to clear (task #726).
  provider_timeout: AUTOMATIC,
  rate_limited: AUTOMATIC,
  quota_exhausted: AUTOMATIC,
  not_found: AUTOMATIC,
  provider_server_error: AUTOMATIC,
  provider_api_error: AUTOMATIC,
  provider_connection_error: AUTOMATIC,
  provider_stream_error: AUTOMATIC,
};

/** A stop reason's recovery; undefined for no reason, or one this table does not know (an older
 * or newer Daemon), which reads as nothing to offer. */
export function stopRecovery(reason: string | null | undefined): StopRecovery | undefined {
  return reason && Object.hasOwn(STOP_REASON_RECOVERY, reason)
    ? STOP_REASON_RECOVERY[reason]
    : undefined;
}

/** Whether a person has to act before the Agent works again. */
export function stopNeedsPerson(reason: string | null | undefined): boolean {
  const recovery = stopRecovery(reason);
  return recovery !== undefined && recovery !== AUTOMATIC;
}
