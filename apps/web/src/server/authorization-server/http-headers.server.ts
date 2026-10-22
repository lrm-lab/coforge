import type { AppRateLimit } from "#src/server/app-rate-limits/app-rate-limit.server";

/** RFC 6749 §5.1–5.2, RFC 6750 §5.3: an answer carrying or refusing a credential is never cached
 * (`Pragma` for HTTP/1.0 caches). */
export const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" } as const;

/** RFC 6585 §4: a request refused for exceeding its rate limit, with the seconds to wait
 * (RFC 9110 §10.2.3). OAuth defines no error code for it, so `rate_limited` is this server's. */
function rateLimitedResponse(retryAfterSeconds: number): Response {
  return Response.json(
    { error: "rate_limited", error_description: "too many requests; retry after the delay" },
    { status: 429, headers: { ...NO_STORE, "retry-after": String(retryAfterSeconds) } },
  );
}

/** Counts one request from `id` against `limit`: the 429 answer when it is over, otherwise
 * `undefined` and the caller goes on. */
export async function refuseIfRateLimited(
  limit: AppRateLimit,
  id: string,
): Promise<Response | undefined> {
  const decision = await limit.admit(id);
  return decision.allowed ? undefined : rateLimitedResponse(decision.retryAfterSeconds);
}
