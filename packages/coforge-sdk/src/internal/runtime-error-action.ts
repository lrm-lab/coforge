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

/** `AgentActivity.runtimeError`: the classified runtime failure this row narrates. */
export type AgentActivityRuntimeError = Readonly<{
  errorClass: string;
  errorReason: string;
  fingerprint: string;
  requiredAction?: RuntimeErrorAction;
}>;

/** The wire shape it encodes into and decodes from: empty strings for absent fields. */
export type RuntimeErrorWire = Readonly<{
  runtimeErrorClass: string;
  runtimeErrorReason: string;
  runtimeErrorFingerprint: string;
  runtimeErrorAction: string;
}>;

export function encodeRuntimeError(
  runtimeError: AgentActivityRuntimeError | undefined,
): RuntimeErrorWire {
  return {
    runtimeErrorClass: runtimeError?.errorClass ?? "",
    runtimeErrorReason: runtimeError?.errorReason ?? "",
    runtimeErrorFingerprint: runtimeError?.fingerprint ?? "",
    runtimeErrorAction: runtimeError?.requiredAction ?? "",
  };
}

export function decodeRuntimeError(v: RuntimeErrorWire): AgentActivityRuntimeError | undefined {
  if (!v.runtimeErrorClass) return undefined;
  return {
    errorClass: v.runtimeErrorClass,
    errorReason: v.runtimeErrorReason,
    fingerprint: v.runtimeErrorFingerprint,
    ...(isRuntimeErrorAction(v.runtimeErrorAction) ? { requiredAction: v.runtimeErrorAction } : {}),
  };
}
