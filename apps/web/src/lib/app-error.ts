export const APP_ERROR_CODES = [
  "INVALID_INPUT",
  "NOT_FOUND",
  "ACCESS_DENIED",
  "CONFLICT",
  "TEMPORARILY_UNAVAILABLE",
  "INTERNAL_ERROR",
  "WORKSPACE_REQUIRED",
  "COMPUTER_OFFLINE",
  "COMPUTER_IDENTITY_UNKNOWN",
  "RELEASE_FEED_UNAVAILABLE",
  "AGENT_CONTEXT_UNAVAILABLE",
  "AGENT_NOT_VISIBLE",
  "AGENT_DM_RESTRICTED",
  "DM_PEER_NOT_IN_WORKSPACE",
  "PUSH_SERVICE_UNREACHABLE",
] as const;

export type AppErrorCode = (typeof APP_ERROR_CODES)[number];

const APP_ERROR_PREFIX = "COFORGE_APP_ERROR:";

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly errorId?: string;

  constructor(code: AppErrorCode, options: { errorId?: string } = {}) {
    super(`${APP_ERROR_PREFIX}${code}${options.errorId ? `:${options.errorId}` : ""}`);
    this.name = "AppError";
    this.code = code;
    this.errorId = options.errorId;
    this.stack = undefined;
  }
}

/**
 * Whether `error` is an `AppError` carrying one of `codes`: `isAppError(error) && error.code === …`
 * in one call, for a `catch` that answers a few codes and rethrows the rest. It narrows to an
 * `AppError` with exactly those codes, so a `false` still leaves room for an `AppError` with
 * another code (a plain `error is AppError` would rule every `AppError` out).
 */
export function isAppErrorCode<const Code extends AppErrorCode>(
  error: unknown,
  ...codes: readonly [Code, ...Code[]]
): error is AppError & { readonly code: Code } {
  return isAppError(error) && (codes as readonly AppErrorCode[]).includes(error.code);
}

export function isAppError(error: unknown): error is AppError {
  if (!(error instanceof Error)) return false;
  if (error.name === "AppError") {
    const code = Reflect.get(error, "code");
    if (!APP_ERROR_CODES.some((candidate) => candidate === code)) return false;
    if (!Reflect.get(error, "errorId") && error.message.startsWith(APP_ERROR_PREFIX)) {
      const [msgCode, ...idParts] = error.message.slice(APP_ERROR_PREFIX.length).split(":");
      if (msgCode === code && idParts.length > 0) {
        Object.assign(error, { errorId: idParts.join(":") });
      }
    }
    return true;
  }
  if (error.name !== "Error" || !error.message.startsWith(APP_ERROR_PREFIX)) return false;
  const [code, ...idParts] = error.message.slice(APP_ERROR_PREFIX.length).split(":");
  if (!APP_ERROR_CODES.some((candidate) => candidate === code)) return false;
  const errorId = idParts.length > 0 ? idParts.join(":") : undefined;
  error.name = "AppError";
  Object.assign(error, { code, ...(errorId ? { errorId } : {}) });
  error.stack = undefined;
  return true;
}
