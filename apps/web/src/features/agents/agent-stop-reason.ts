import { m } from "#src/paraglide/messages";

/** What a stop reason says: a short status word, and the one thing a person does about it. */
export type StopReasonCopy = { label: () => string; detail: () => string };

const SIGN_IN = { label: m.agent_stop_sign_in, detail: m.agent_stop_sign_in_detail };
const INSTALL = { label: m.agent_stop_install, detail: m.agent_stop_install_detail };
const UNUSABLE = { label: m.agent_stop_unusable, detail: m.agent_stop_unusable_detail };
const MODEL = { label: m.agent_stop_model, detail: m.agent_stop_model_detail };

/**
 * The stop reasons only a person can clear (task #682): the launch failures a Start does not
 * retry (`NON_RETRYABLE_LAUNCH_FAILURE_REASONS` in the Daemon) and the runtime failures that take
 * a running Agent offline (`runtime-error-rules.ts`). A reason not listed here, transient or
 * unknown, leaves the plain status word.
 */
const STOP_REASONS: Record<string, StopReasonCopy> = {
  billing_exhausted: {
    label: m.agent_status_quota_exhausted,
    detail: m.agent_status_quota_exhausted_detail,
  },
  runtime_login_required: SIGN_IN,
  auth_failed: SIGN_IN,
  runtime_not_installed: INSTALL,
  runtime_not_found: INSTALL,
  runtime_version_too_old: { label: m.agent_stop_update, detail: m.agent_stop_update_detail },
  runtime_unusable: UNUSABLE,
  runtime_unavailable: UNUSABLE,
  runtime_private: { label: m.agent_stop_private, detail: m.agent_stop_private_detail },
  model_not_found: MODEL,
  model_provider_not_configured: MODEL,
  model_config_error: MODEL,
  agent_environment_invalid: {
    label: m.agent_stop_environment,
    detail: m.agent_stop_environment_detail,
  },
};

export function stopReasonCopy(reason: string | null | undefined): StopReasonCopy | undefined {
  return reason && Object.hasOwn(STOP_REASONS, reason) ? STOP_REASONS[reason] : undefined;
}

/** The reason and what to do, as one line: a banner's where the log is not the viewer's, or a
 * refused Start's. The provider's raw error is never in it (a `401 "invalid api key"` means nothing
 * to the reader, Frank 11-09); it stays in the logs and the copied diagnostics. */
export function stopReasonSentence(copy: StopReasonCopy) {
  return m.agent_stop_reason_sentence({ label: copy.label(), detail: copy.detail() });
}
