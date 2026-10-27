import { isAppError } from "#src/lib/app-error";
import { toPublicServerError } from "#src/server/errors/public-error.server";
import type { SignInLimit } from "./sign-in-rate-limits.server";

/**
 * The steps of a sign-in, each with what its failure is called. A failed sign-in tells the
 * browser only that it failed, so this is the operator's whole account of why.
 */
const FAILURE_REASONS = {
  password_sign_in: "Authing did not complete the password sign-in",
  passcode_sign_in: "Authing did not complete the verification-code sign-in",
  github_sign_in: "Authing did not complete the GitHub sign-in",
  send_code: "Authing did not send the verification code",
  password_reset: "Authing did not complete the password reset",
  userinfo: "failed to fetch Authing user info",
  user_resolution: "failed to resolve user",
} as const;

export type SignInFailureStage = keyof typeof FAILURE_REASONS;

/** What a provider's error code looks like (RFC 6749 §5.2: `invalid_grant`; Authing's `apiCode`:
 * `2333`); anything else is not one. */
const PROVIDER_ERROR_CODE = /^[A-Za-z0-9_.-]{1,64}$/;

/** `value` when it is a provider error code, else `undefined`: free text may hold anything. */
export function providerErrorCode(value: unknown): string | undefined {
  return typeof value === "string" && PROVIDER_ERROR_CODE.test(value) ? value : undefined;
}

/**
 * A sign-in that failed at `stage`. It carries only what is safe to log: the step, its
 * fixed reason, Authing's HTTP status, and Authing's error code. The underlying exception,
 * whose message may hold an email, SQL, or a token, stays in `cause` and is never logged.
 */
export class SignInFailure extends Error {
  readonly stage: SignInFailureStage;
  readonly reason: string;
  readonly status?: number;
  readonly providerError?: string;

  constructor(
    stage: SignInFailureStage,
    options: {
      /** Only for a reason more precise than the step's own; it must be fixed text. */
      reason?: string;
      status?: number;
      /** Authing's `apiCode`; kept only when it is a provider error code. */
      providerError?: unknown;
      cause?: unknown;
    } = {},
  ) {
    const reason = options.reason ?? FAILURE_REASONS[stage];
    const providerError = providerErrorCode(options.providerError);
    const detail = providerError ?? options.status;
    super(detail === undefined ? reason : `${reason}: ${detail}`, { cause: options.cause });
    this.name = "SignInFailure";
    this.stage = stage;
    this.reason = reason;
    if (options.status !== undefined) this.status = options.status;
    if (providerError !== undefined) this.providerError = providerError;
  }
}

/**
 * Runs one step of the sign-in. Whatever it throws is that step's failure: an error that already
 * names its step passes through, anything else (a refused connection, an unreadable body, a
 * database error) is wrapped, so the step is known wherever the exception came from.
 */
export async function atSignInStage<T>(
  stage: SignInFailureStage,
  step: () => Promise<T>,
): Promise<T> {
  try {
    return await step();
  } catch (error) {
    throw error instanceof SignInFailure ? error : new SignInFailure(stage, { cause: error });
  }
}

/**
 * Logs why a sign-in failed as one `auth.sign_in_failed` line. An exception under
 * the failure is reported the way every server exception is (`server_operation_failed`, with
 * stack positions), and the `errorId` on both lines ties the two together.
 */
export function reportSignInFailure(error: unknown): void {
  const failure = error instanceof SignInFailure ? error : null;
  const cause = failure ? failure.cause : error;
  const record: Record<string, unknown> = {
    event: "auth.sign_in_failed",
    stage: failure?.stage ?? "unexpected",
    reason: failure?.reason ?? "unexpected error",
    ...(failure?.status !== undefined ? { status: failure.status } : {}),
    ...(failure?.providerError !== undefined ? { providerError: failure.providerError } : {}),
  };
  if (cause !== undefined) {
    const reported = toPublicServerError(cause);
    record.errorType = cause instanceof Error ? "error" : "non_error";
    // An AppError's code is a fixed public name (`ACCESS_DENIED`), safe to log.
    if (isAppError(cause)) record.errorCode = cause.code;
    if (isAppError(reported) && reported.errorId) record.errorId = reported.errorId;
  }
  console.error(JSON.stringify(record));
}

/**
 * Logs a sign-in Authing refused as one `auth.sign_in_rejected` line: no email, no password, only
 * the codes Authing answered with, so a misconfigured app can be told from a wrong password.
 */
export function reportSignInRejected(rejected: {
  statusCode: number;
  providerError?: string | undefined;
}): void {
  console.warn(
    JSON.stringify({
      event: "auth.sign_in_rejected",
      statusCode: rejected.statusCode,
      ...(providerErrorCode(rejected.providerError) !== undefined
        ? { providerError: rejected.providerError }
        : {}),
    }),
  );
}

/** Logs a GitHub sign-in the browser came back from without a usable authorization as one
 * `auth.github_sign_in_rejected` line: `state` when it did not match the one the sign-in started
 * with (or there was none), `denied` when the person refused on GitHub, `error` when GitHub
 * reported another error, `no_code` when it sent no code. Neither the state nor a code is logged. */
export function reportGitHubSignInRejected(reason: "state" | "denied" | "error" | "no_code"): void {
  console.warn(JSON.stringify({ event: "auth.github_sign_in_rejected", reason }));
}

/** Logs a sign-in refused by one of our own limits as one `auth.sign_in_rate_limited` line: which
 * limit, and neither the email nor the address. */
export function reportSignInRateLimited(limit: SignInLimit): void {
  console.warn(JSON.stringify({ event: "auth.sign_in_rate_limited", limit }));
}

/** Logs a verification code not sent because one of our own limits refused it as one
 * `auth.code_send_rate_limited` line: which limit, and neither the phone number, the email nor the
 * address. */
export function reportCodeSendRateLimited(limit: "address" | "destination"): void {
  console.warn(JSON.stringify({ event: "auth.code_send_rate_limited", limit }));
}

/** Logs that Authing refused to send a verification code because it was asked too often, as one
 * `auth.code_send_throttled` line. */
export function reportCodeSendThrottled(): void {
  console.warn(JSON.stringify({ event: "auth.code_send_throttled" }));
}

/** Logs a password-reset code Authing would not send, as one `auth.password_reset_code_not_sent`
 * line, which the person is not told of (the answer must not say whether an account has the
 * destination): `refused` when Authing would not serve the request (it knows no such account),
 * `throttled` when it was asked too often. Neither the destination nor the address is logged. */
export function reportPasswordResetCodeNotSent(
  reason: "refused" | "throttled",
  providerError?: string | undefined,
): void {
  console.warn(
    JSON.stringify({
      event: "auth.password_reset_code_not_sent",
      reason,
      ...(providerErrorCode(providerError) !== undefined ? { providerError } : {}),
    }),
  );
}

/** Logs a password reset Authing refused as one `auth.password_reset_rejected` line: whether it
 * was the verification code or the new password, and the codes Authing answered with. */
export function reportPasswordResetRejected(rejected: {
  refused: "reset_code" | "password";
  statusCode: number;
  providerError?: string | undefined;
}): void {
  console.warn(
    JSON.stringify({
      event: "auth.password_reset_rejected",
      refused: rejected.refused,
      statusCode: rejected.statusCode,
      ...(providerErrorCode(rejected.providerError) !== undefined
        ? { providerError: rejected.providerError }
        : {}),
    }),
  );
}

/** Logs that Authing did not revoke a sign-in's token, as one `auth.token_revocation_failed` line
 * without the token. The sign-in stands: the token expires on its own. */
export function reportTokenRevocationFailure(error: unknown): void {
  console.warn(
    JSON.stringify({
      event: "auth.token_revocation_failed",
      errorType: error instanceof Error ? error.name : "non_error",
    }),
  );
}
