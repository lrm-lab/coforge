import { MAX_RETURN_TO_LENGTH, signInHref } from "#src/features/auth/return-to";
import { AUTHORIZATION_ENDPOINT_PATH } from "#src/lib/oidc-paths";
import { readSignedValue, signValue } from "#src/server/auth/signed-value.server";
import type { AuthorizationRequest } from "./authorization-request.server";

/**
 * `prompt=login` and `max_age` (OIDC Core §3.1.2.1). The person is sent to sign in again with the
 * same request plus a signed note of when CoForge asked; on return, a sign-in after that time
 * meets both, and anything else answers `login_required` instead of asking again.
 */

/** The query parameter that carries the note; one the app wrote is ignored unless CoForge signed
 * it. */
const SIGN_IN_REQUESTED = "coforge_signed_in_after";
const NOTE_TTL_SECONDS = 15 * 60;

/** The longest request that still fits the sign-in return path with the note added. */
export const MAX_AUTHORIZATION_REQUEST_LENGTH = MAX_RETURN_TO_LENGTH - 256;

/** Whether this request needs a sign-in no older than CoForge can vouch for. */
export function asksForRecentSignIn(request: AuthorizationRequest): boolean {
  return request.prompt.includes("login") || request.maxAge !== undefined;
}

/** When CoForge asked for the sign-in this request came back from, if it did and recently. */
export function signInRequestedAt(query: URLSearchParams, secret: string, now: Date) {
  const note = readSignedValue<{ at: number }>(
    "sign-in-requested",
    query.get(SIGN_IN_REQUESTED),
    secret,
  );
  const seconds = now.getTime() / 1000;
  return note && typeof note.at === "number" && seconds - note.at <= NOTE_TTL_SECONDS
    ? note.at
    : undefined;
}

/** Whether a sign-in at `authTime` meets the request's `prompt=login` and `max_age`. */
export function signInIsRecentEnough(
  request: AuthorizationRequest,
  authTime: number,
  now: Date,
  requestedAt: number | undefined,
): boolean {
  const renewed = requestedAt !== undefined && authTime >= requestedAt;
  if (request.prompt.includes("login") && !renewed) return false;
  const age = now.getTime() / 1000 - authTime;
  return request.maxAge === undefined || age <= request.maxAge || renewed;
}

/** Sign-in at Authing that asks again (`prompt=login`), back to the same request with a note of
 * when CoForge asked. */
export function signInAgainHref(search: string, secret: string, now: Date): string {
  const query = new URLSearchParams(search);
  query.set(
    SIGN_IN_REQUESTED,
    signValue("sign-in-requested", { at: Math.floor(now.getTime() / 1000) }, secret),
  );
  return signInHref(`${AUTHORIZATION_ENDPOINT_PATH}?${query}`, { prompt: "login" });
}
