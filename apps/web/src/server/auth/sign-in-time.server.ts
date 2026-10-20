import { decodeJwt } from "jose";

/**
 * When the person signed in, in epoch seconds: the `auth_time` of the ID token Authing's token
 * endpoint returned, else `fallback` (the callback's own time). The token came straight from the
 * token endpoint over TLS, so its claims are read without checking the signature (OIDC Core
 * §3.1.3.7, item 6).
 */
export function signInTime(idToken: string | undefined, fallback: number): number {
  if (!idToken) return fallback;
  try {
    const { auth_time: authTime } = decodeJwt(idToken);
    return typeof authTime === "number" && Number.isFinite(authTime) ? authTime : fallback;
  } catch {
    return fallback;
  }
}

/** Makes Authing sign the person in again even when it has a session of its own (OIDC Core
 * §3.1.2.1 `prompt=login`); `max_age=0` also has it report the new sign-in's `auth_time`. */
export function askToSignInAgain(authorizationUrl: URL): void {
  authorizationUrl.searchParams.set("prompt", "login");
  authorizationUrl.searchParams.set("max_age", "0");
}
