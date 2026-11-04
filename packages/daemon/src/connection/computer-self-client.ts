import { isRecord } from "@lrm/coforge-sdk/internal";

/** One Computer self-service call's time limit; a stuck server must not hold the connect path. */
const REQUEST_TIMEOUT_MS = 15_000;

/** Why one self-service call did not apply: `unsupported` means the route is not on this server
 * (404/405 — an older release, never retried); anything else is retryable on the next start. */
export type ComputerSelfFailure = { kind: "unsupported" | "retryable"; detail: string };

export type ComputerSelfResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ComputerSelfFailure };

const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;

async function call<T>(
  serverHttpUrl: string,
  path: string,
  apiKey: string,
  signal: AbortSignal,
  timeoutMs: number,
  validate: (body: unknown) => T | undefined,
): Promise<ComputerSelfResult<T>> {
  let response: Response;
  try {
    response = await fetch(`${new URL(serverHttpUrl).origin}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    });
  } catch (error) {
    return {
      ok: false,
      error: { kind: "retryable", detail: error instanceof Error ? error.message : String(error) },
    };
  }
  if (response.status === 404 || response.status === 405)
    return { ok: false, error: { kind: "unsupported", detail: `http ${response.status}` } };
  if (!response.ok)
    return { ok: false, error: { kind: "retryable", detail: `http ${response.status}` } };
  const body: unknown = await response.json().catch(() => undefined);
  const value = validate(body);
  if (value === undefined)
    return { ok: false, error: { kind: "retryable", detail: "malformed response" } };
  return { ok: true, value };
}

/** The daemon's calls on its own Computer self-service routes (`/api/computer/*`, step 1 of
 * task #417). The key is the Bearer credential; it never enters the returned detail. */
export function createComputerSelfClient(serverHttpUrl: string, timeoutMs = REQUEST_TIMEOUT_MS) {
  return {
    /** `POST /api/computer/swap-key`: mint an `sk_computer` while the `dk_` stays live. */
    swapKey(apiKey: string, signal: AbortSignal) {
      return call(serverHttpUrl, "/api/computer/swap-key", apiKey, signal, timeoutMs, (body) =>
        isRecord(body) && isText(body.apiKey) ? { apiKey: body.apiKey } : undefined,
      );
    },
    /** `POST /api/computer/confirm-key`: retire the `dk_` and sibling unconfirmed keys. Idempotent. */
    confirmKey(apiKey: string, signal: AbortSignal) {
      return call(serverHttpUrl, "/api/computer/confirm-key", apiKey, signal, timeoutMs, (body) =>
        isRecord(body) && body.ok === true ? {} : undefined,
      );
    },
  };
}

export type ComputerSelfClient = ReturnType<typeof createComputerSelfClient>;
