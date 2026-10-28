import { boundedPayload } from "./codec";
import { isScopeId } from "./scope-id";
import { RUNTIME_PROVIDER } from "./runtime-provider";

/** A login's id: server generated, read as a path segment and a Redis key part. */
export const RUNTIME_AUTH_LOGIN_ID_PATTERN = /^rtl_[A-Za-z0-9_-]{16,64}$/;
export const RUNTIME_AUTH_PROVIDERS = [
  RUNTIME_PROVIDER.CLAUDE_CODE,
  RUNTIME_PROVIDER.CODEX,
  RUNTIME_PROVIDER.KIRO,
  RUNTIME_PROVIDER.COMMAND_CODE,
] as const;
export type RuntimeAuthProvider = (typeof RUNTIME_AUTH_PROVIDERS)[number];
export const RUNTIME_AUTH_LOGIN_FAILURE_REASONS = [
  "timed_out",
  "rejected",
  "not_logged_in",
  "interaction_failed",
  "process_failed",
] as const;
export const RUNTIME_AUTH_LOGOUT_FAILURE_REASONS = [
  "timed_out",
  "rejected",
  "process_failed",
  "still_logged_in",
] as const;
export const RUNTIME_AUTH_UNSUPPORTED_REASONS = [
  "not_installed",
  "version_unsupported",
  "unsupported_installation",
] as const;
/** Failure detail codes the web maps to text. Any other detail is dropped before it is reported. */
export const RUNTIME_AUTH_FAILURE_DETAIL_CODES = [
  "kiro_device_flow_disabled",
  "kiro_external_idp_unsupported",
  "command_code_browser_unavailable",
  "command_code_api_key_env",
] as const;
export type RuntimeAuthFailureDetailCode = (typeof RUNTIME_AUTH_FAILURE_DETAIL_CODES)[number];
export function isRuntimeAuthFailureDetailCode(
  value: unknown,
): value is RuntimeAuthFailureDetailCode {
  return (RUNTIME_AUTH_FAILURE_DETAIL_CODES as readonly unknown[]).includes(value);
}

export const MAX_BYTES = 32_768;
export const MAX_CODE = 1024;
export const MAX_URL = 4096;
export const MAX_LABEL = 80;
export const MAX_METHOD_LABEL = 40;
export const MAX_USER_CODE = 32;
export const MAX_DETAIL = 300;
export const MAX_MESSAGE = 500;
export const MAX_DEVICE_CODE_SECONDS = 3600;
export const MAX_SEQUENCE = 2 ** 31 - 1;
/** Every text but the pasted code: no control, format or line-separator character; tab and newline are allowed. */
export const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]/u;
export const MASK_MARKER = /[*•…]/u;

export type RuntimeAuthScope = { protocolMajor: 1; workspaceId: string; computerId: string };

export type Unsupported = {
  kind: "unsupported";
  reason: RuntimeAuthUnsupportedReason;
  detail?: string;
};
export type RuntimeAuthUnsupportedReason = (typeof RUNTIME_AUTH_UNSUPPORTED_REASONS)[number];

export function bounded(bytes: Uint8Array): Uint8Array {
  return boundedPayload(bytes, MAX_BYTES, "Runtime auth");
}

export function scope(value: RuntimeAuthScope): RuntimeAuthScope {
  if (value.protocolMajor !== 1 || !isScopeId(value.workspaceId) || !isScopeId(value.computerId))
    throw new Error("invalid runtime auth scope");
  return {
    protocolMajor: value.protocolMajor,
    workspaceId: value.workspaceId,
    computerId: value.computerId,
  };
}

export function loginId(value: string): string {
  if (!RUNTIME_AUTH_LOGIN_ID_PATTERN.test(value)) throw new Error("invalid runtime auth login id");
  return value;
}

export function requestId(value: string): string {
  if (!isScopeId(value)) throw new Error("invalid runtime auth request id");
  return value;
}

/** The pasted code is a credential and is never trimmed or rewritten here: callers normalize it. */
export function code(value: string): string {
  if (!value || [...value].length > MAX_CODE || /[\p{Cc}\p{Cf}\s]/u.test(value))
    throw new Error("invalid runtime auth code: it must be one run of printable characters");
  return value;
}

export function text(value: string, max: number, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || [...trimmed].length > max || CONTROL.test(trimmed))
    throw new Error(`invalid runtime auth ${label}`);
  return trimmed;
}

export function optionalText(
  value: string | undefined,
  max: number,
  label: string,
): string | undefined {
  return value === undefined ? undefined : text(value, max, label);
}

/** Relays the exact string: it is already trimmed, free of control characters, and carries no credentials. */
export function httpsUrl(value: string): string {
  try {
    const url = new URL(value);
    if (
      value.length <= MAX_URL &&
      !/[\p{Cc}\p{Cf}\s]/u.test(value) &&
      url.protocol === "https:" &&
      !url.username &&
      !url.password
    )
      return value;
  } catch {
    // Falls through to the refusal below.
  }
  throw new Error("invalid runtime auth link: only plain https links are relayed");
}

/** Whether a pasted code, once normalized by the caller, is one the daemon will take. */
export function isRuntimeAuthCode(value: string): boolean {
  try {
    code(value);
    return true;
  } catch {
    return false;
  }
}

export function oneOf<T extends string>(values: readonly T[], value: string, label: string): T {
  if (!(values as readonly string[]).includes(value))
    throw new Error(`invalid runtime auth ${label}`);
  return value as T;
}

/** Starts at 1: proto3 does not put a zero on the wire, so 0 would be indistinguishable from absent. */
export function sequence(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_SEQUENCE)
    throw new Error("invalid runtime auth sequence");
  return value;
}

export function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

export function providerOf(value: string): RuntimeAuthProvider {
  return oneOf(RUNTIME_AUTH_PROVIDERS, value, "provider");
}

export function checkFailed<R extends string>(
  value: { reason: string; detail?: string },
  reasons: readonly R[],
): { reason: R; detail?: string } {
  return defined({
    reason: oneOf(reasons, value.reason, "failure reason"),
    detail: optionalText(value.detail, MAX_DETAIL, "detail"),
  });
}

export function checkUnsupported(value: Unsupported): Unsupported {
  return {
    kind: "unsupported",
    ...checkFailed(
      { reason: value.reason, detail: value.detail },
      RUNTIME_AUTH_UNSUPPORTED_REASONS,
    ),
  };
}
