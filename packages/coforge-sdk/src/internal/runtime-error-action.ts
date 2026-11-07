import { truncateCodePoints } from "./truncate";

/** The action only a person can take before an Agent works again, reported on a runtime_error
 * Activity's `runtimeError.requiredAction`; absent when the failure needs no human step. */
export const RUNTIME_ERROR_ACTION = {
  USER_REAUTH: "user_reauth",
  USER_MODEL_ACCESS: "user_model_access",
} as const;
export type RuntimeErrorAction = (typeof RUNTIME_ERROR_ACTION)[keyof typeof RUNTIME_ERROR_ACTION];
export function isRuntimeErrorAction(value: string): value is RuntimeErrorAction {
  return (
    value === RUNTIME_ERROR_ACTION.USER_REAUTH || value === RUNTIME_ERROR_ACTION.USER_MODEL_ACCESS
  );
}

/** The cap on provider error text anyone reads: applied where a Daemon writes it and again where
 * a frame is decoded, since a Daemon on someone's machine can send any length. */
export const MAX_VISIBLE_ERROR_CHARS = 512;

/** The classification on the `runtime_stalled` Activity a daemon sends when a turn stalls again
 * past its unattended restarts (task #404). The process still runs, so this, not a launch error
 * code, is the reason the web shows for the stuck Agent (`failureReason`, task #418). */
export const STALLED_RESTART_LIMIT_ERROR = {
  errorClass: "TurnStallError",
  errorReason: "stalled_restart_limit",
} as const;

/** `AgentActivity.runtimeError`: the classified runtime failure this row narrates. */
export type AgentActivityRuntimeError = Readonly<{
  errorClass: string;
  errorReason: string;
  fingerprint: string;
  requiredAction?: RuntimeErrorAction;
  /** The ISO time a retryable failure named as its next attempt; absent when it named none. */
  retryNotBefore?: string;
  /** What the provider itself said, redacted, on a quota or billing failure that took the Agent
   * offline; absent otherwise and from older daemons. */
  providerMessage?: string;
}>;

/** The wire shape it encodes into and decodes from: empty strings for absent fields. */
export type RuntimeErrorWire = Readonly<{
  runtimeErrorClass: string;
  runtimeErrorReason: string;
  runtimeErrorFingerprint: string;
  runtimeErrorAction: string;
  runtimeErrorRetryNotBefore: string;
  runtimeErrorProviderMessage: string;
}>;

export function encodeRuntimeError(
  runtimeError: AgentActivityRuntimeError | undefined,
): RuntimeErrorWire {
  return {
    runtimeErrorClass: runtimeError?.errorClass ?? "",
    runtimeErrorReason: runtimeError?.errorReason ?? "",
    runtimeErrorFingerprint: runtimeError?.fingerprint ?? "",
    runtimeErrorAction: runtimeError?.requiredAction ?? "",
    runtimeErrorRetryNotBefore: runtimeError?.retryNotBefore ?? "",
    runtimeErrorProviderMessage: runtimeError?.providerMessage ?? "",
  };
}

export function decodeRuntimeError(v: RuntimeErrorWire): AgentActivityRuntimeError | undefined {
  if (!v.runtimeErrorClass) return undefined;
  return {
    errorClass: v.runtimeErrorClass,
    errorReason: v.runtimeErrorReason,
    fingerprint: v.runtimeErrorFingerprint,
    ...(isRuntimeErrorAction(v.runtimeErrorAction) ? { requiredAction: v.runtimeErrorAction } : {}),
    ...(v.runtimeErrorRetryNotBefore ? { retryNotBefore: v.runtimeErrorRetryNotBefore } : {}),
    ...(v.runtimeErrorProviderMessage
      ? {
          providerMessage: truncateCodePoints(
            v.runtimeErrorProviderMessage,
            MAX_VISIBLE_ERROR_CHARS,
          ),
        }
      : {}),
  };
}
