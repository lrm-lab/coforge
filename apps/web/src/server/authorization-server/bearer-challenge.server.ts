import { NO_STORE } from "./http-headers.server";

/** RFC 6750 §2.1: `Bearer` and a b64token. */
const BEARER = /^Bearer +([A-Za-z0-9\-._~+/]+=*) *$/i;

/** The token of an Authorization header that carries a well-formed Bearer credential. */
export function bearerToken(authorization: string): string | undefined {
  return BEARER.exec(authorization)?.[1];
}

/** Whether the Authorization header names the Bearer scheme at all (RFC 6750 §3: a request that
 * does not gets the bare challenge, one that does but is malformed gets `invalid_request`). */
export function isBearerScheme(authorization: string | null): authorization is string {
  return authorization !== null && /^Bearer(?: |$)/i.test(authorization);
}

export type BearerError = "invalid_request" | "invalid_token" | "insufficient_scope";

/** RFC 6750 §3: the bare challenge when `error` is absent, else a JSON error naming its code
 * (and, for `insufficient_scope`, the `scope` needed). Never cached. */
export function bearerChallenge(
  issuer: string,
  status: 400 | 401 | 403,
  refusal?: { error: BearerError; description: string; scope?: string },
): Response {
  const realm = `Bearer realm="${issuer}"`;
  if (!refusal)
    return new Response(null, { status, headers: { ...NO_STORE, "www-authenticate": realm } });
  const scope = refusal.scope ? `, scope="${refusal.scope}"` : "";
  return Response.json(
    { error: refusal.error, error_description: refusal.description },
    {
      status,
      headers: {
        ...NO_STORE,
        "www-authenticate": `${realm}, error="${refusal.error}"${scope}`,
      },
    },
  );
}

/**
 * The Bearer token of a request's Authorization header (RFC 6750 §2.1), or the response to send:
 * the bare challenge when the request names no Bearer scheme, `invalid_request` (400) when it
 * names it but carries no well-formed credential.
 */
export function bearerFromRequest(request: Request, issuer: string): string | Response {
  const authorization = request.headers.get("authorization");
  if (!isBearerScheme(authorization)) return bearerChallenge(issuer, 401);
  return (
    bearerToken(authorization) ??
    bearerChallenge(issuer, 400, {
      error: "invalid_request",
      description: "the Authorization header is not a Bearer token",
    })
  );
}
