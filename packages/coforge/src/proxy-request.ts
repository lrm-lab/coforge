/** The proxied requests every local client operation shares: the preflight a request runs before
 * it is issued, and the routes that answer a domain error as `{ ok: false, errorCode, error }`. */

import { CliError, NO_MESSAGE_SENT_NEXT_ACTION } from "./cli-error";

export function operationFailedCode(operation: string): string {
  return `${operation.toUpperCase().replace(/-/g, "_")}_FAILED`;
}

/** The agent-context token grammar the proxy checks before issuing any request. */
const PROXY_CONTEXT_PATTERN = /^sfp_[A-Za-z0-9_-]{43}$/;

/** A local condition that meant no request was ever issued: nothing to wait on or undo. */
export function preIssuanceError(operation: string, message: string): CliError {
  const isSend = operation === "send";
  return new CliError({
    code: isSend ? "SEND_PRECONDITION_FAILED" : operationFailedCode(operation),
    message,
    retryable: false,
    ...(isSend ? { draftSaved: false, suggestedNextAction: NO_MESSAGE_SENT_NEXT_ACTION } : {}),
  });
}
/** The preflight every proxied request runs before it issues: the context must exist and match
 * the token grammar, and a proxy must be configured. Raises the operation's own pre-issuance
 * error, so no request is ever sent on a missing setup. */
export function requireProxySetup(operation: string, context: string, proxyUrl: string): void {
  if (!context) throw preIssuanceError(operation, "coforge agent context is not configured");
  if (!PROXY_CONTEXT_PATTERN.test(context))
    throw preIssuanceError(operation, "coforge agent context is invalid");
  if (!proxyUrl) throw preIssuanceError(operation, "coforge agent proxy is not configured");
}

/**
 * Calls a route that always answers a domain error as JSON `{ ok: false, errorCode, error }`
 * for Manual, user info, profile and App config: `errorCode` becomes the `CliError` code directly.
 * A GET carries `query`; a route that takes a JSON body carries `body`. A route may supply
 * guidance for its decoded error code without duplicating the request or error handling.
 */
export async function envelopeRequest<T>(
  proxyEndpoint: (path: string) => URL,
  context: string,
  proxyUrl: string,
  request: { method: string; path: string; query?: Record<string, string>; body?: unknown },
  decode: (value: unknown) => T,
  decodeError: (value: unknown) => { errorCode: string; error: string } | undefined,
  operation: string,
  nextAction?: (errorCode: string | undefined) => string | undefined,
): Promise<T> {
  requireProxySetup(operation, context, proxyUrl);
  const endpoint = proxyEndpoint(request.path);
  for (const [key, value] of Object.entries(request.query ?? {}))
    endpoint.searchParams.set(key, value);
  const hasBody = request.body !== undefined;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: request.method,
      headers: {
        authorization: `Bearer ${context}`,
        ...(hasBody ? { "content-type": "application/json" } : {}),
      },
      ...(hasBody ? { body: JSON.stringify(request.body) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new CliError({
      code: operationFailedCode(operation),
      message: "agent proxy request failed (network or timeout)",
      retryable: false,
    });
  }
  const rawBody: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const errorBody = decodeError(rawBody);
    throw new CliError({
      code: errorBody?.errorCode
        ? errorBody.errorCode.toUpperCase()
        : operationFailedCode(operation),
      message: errorBody?.error ?? `HTTP ${response.status}`,
      retryable: false,
      suggestedNextAction: nextAction?.(errorBody?.errorCode),
    });
  }
  return decode(rawBody);
}
