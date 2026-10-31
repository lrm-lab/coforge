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
  "AGENT_NOT_VISIBLE",
  "AGENT_DM_RESTRICTED",
  "DM_PEER_NOT_IN_WORKSPACE",
  "AMBIGUOUS_TARGET",
  "AGENT_DM_CHAIN_LIMIT",
  "AGENT_DM_RATE_LIMIT",
  "INVALID_TARGET",
  "TARGET_NOT_ACCESSIBLE",
  "PUSH_SERVICE_UNREACHABLE",
] as const;

export type AppErrorCode = (typeof APP_ERROR_CODES)[number];

/**
 * The HTTP status each `AppErrorCode` answers at a request boundary (the Agent HTTP API's
 * `agentErrorResponse` and the RPC layer's `handleRequestError`). Keep both consumers on this
 * one table so a new code picks its status once.
 */
export const APP_ERROR_HTTP_STATUS: Record<AppErrorCode, number> = {
  INVALID_INPUT: 400,
  NOT_FOUND: 404,
  ACCESS_DENIED: 403,
  CONFLICT: 409,
  TEMPORARILY_UNAVAILABLE: 503,
  WORKSPACE_REQUIRED: 400,
  INTERNAL_ERROR: 500,
  COMPUTER_OFFLINE: 409,
  COMPUTER_IDENTITY_UNKNOWN: 409,
  RELEASE_FEED_UNAVAILABLE: 503,
  // A private Agent the viewer cannot see: 404 status, no Agent details.
  AGENT_NOT_VISIBLE: 404,
  // A private Agent's direct conversation is scoped to its creator: the caller can
  // see the Agent but its DM stays read-only for them, so this is a 403, not a 404.
  AGENT_DM_RESTRICTED: 403,
  // The person on the other side of a direct message is not a member of the Workspace (never
  // was, or left): nothing new is sent to them.
  DM_PEER_NOT_IN_WORKSPACE: 403,
  AMBIGUOUS_TARGET: 409,
  AGENT_DM_CHAIN_LIMIT: 429,
  AGENT_DM_RATE_LIMIT: 429,
  // A target that fails the `@name(~human|~agent)` / `#channel` / `attachment:` grammar.
  INVALID_TARGET: 400,
  // A well-formed target the caller cannot reach: unknown username, no usable Agent, a
  // direct-message scope outside the Workspace. Unknown and unreachable read the same
  // deliberately — the send reveals neither.
  TARGET_NOT_ACCESSIBLE: 403,
  // The server could not reach this browser's push service: the caller should
  // retry another way, not treat it as a permanent failure.
  PUSH_SERVICE_UNREACHABLE: 503,
};

const APP_ERROR_PREFIX = "COFORGE_APP_ERROR:";

export type AppErrorDetails = Record<string, string | number>;

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly errorId?: string;

  /** Facts a client can act on. They cross to the browser in the message; a hint does not. */
  readonly details?: AppErrorDetails;
  /** A sentence for an Agent, appended to its refusal. Never sent to the browser. */
  readonly hint?: string;

  constructor(
    code: AppErrorCode,
    options: { errorId?: string; details?: AppErrorDetails; hint?: string } = {},
  ) {
    super(
      `${APP_ERROR_PREFIX}${code}${options.errorId ? `:${options.errorId}` : ""}${
        options.details ? ` ${JSON.stringify(options.details)}` : ""
      }`,
    );
    this.name = "AppError";
    this.code = code;
    this.errorId = options.errorId;
    this.details = options.details;
    this.hint = options.hint;
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
      const wire = readWire(error.message);
      if (wire.code === code && wire.errorId) Object.assign(error, { errorId: wire.errorId });
      if (wire.code === code && wire.details && !Reflect.get(error, "details"))
        Object.assign(error, { details: wire.details });
    }
    return true;
  }
  if (error.name !== "Error" || !error.message.startsWith(APP_ERROR_PREFIX)) return false;
  const { code, errorId, details } = readWire(error.message);
  if (!APP_ERROR_CODES.some((candidate) => candidate === code)) return false;
  error.name = "AppError";
  Object.assign(error, { code, ...(errorId ? { errorId } : {}), ...(details ? { details } : {}) });
  error.stack = undefined;
  return true;
}

/** `COFORGE_APP_ERROR:<code>[:<errorId>][ <details as JSON>]`: the details come off first, as they
 * may hold colons. Details that do not parse are dropped. */
function readWire(message: string): { code: string; errorId?: string; details?: AppErrorDetails } {
  const rest = message.slice(APP_ERROR_PREFIX.length);
  const at = rest.indexOf(" {");
  let details: AppErrorDetails | undefined;
  if (at >= 0) {
    try {
      const parsed: unknown = JSON.parse(rest.slice(at + 1));
      if (isFlatRecord(parsed)) details = parsed;
    } catch {
      // Not details: ignored.
    }
  }
  const [code = "", ...idParts] = (at >= 0 ? rest.slice(0, at) : rest).split(":");
  return {
    code,
    ...(idParts.length ? { errorId: idParts.join(":") } : {}),
    ...(details ? { details } : {}),
  };
}

function isFlatRecord(value: unknown): value is AppErrorDetails {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string" || typeof entry === "number")
  );
}
