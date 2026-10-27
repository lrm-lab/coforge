import { isNonLocalizedPath } from "#src/lib/non-localized-path";
import { deLocalizeHref, localizeHref } from "#src/paraglide/runtime";

/** Longer return paths are dropped: one travels in the sign-in page's URL and is sent back with
 * the form, and nothing legitimate is anywhere near this long. */
export const MAX_RETURN_TO_LENGTH = 2_048;
const SAME_SITE_BASE = "https://coforge.invalid";

/**
 * The page a person goes back to after signing in (`/login?returnTo=…`), or `undefined` when the
 * value could take them anywhere but a page of this site. Only a path is accepted: a single
 * leading `/` and no `\` (browsers read it as `/`), no scheme, and no control characters, which
 * browsers strip before parsing (`/\t/evil.com` is `//evil.com`). The path comes back resolved
 * and percent-encoded, as a Location header needs it, and must still not start with `//`
 * (`/.//evil.com` resolves to that).
 */
export function safeReturnTo(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("\\")) return undefined;
  if (value.length > MAX_RETURN_TO_LENGTH) return undefined;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return undefined;
  }
  let url: URL;
  try {
    url = new URL(value, SAME_SITE_BASE);
  } catch {
    return undefined;
  }
  const path = `${url.pathname}${url.search}${url.hash}`;
  if (url.origin !== SAME_SITE_BASE || path.startsWith("//")) return undefined;
  return path.length > MAX_RETURN_TO_LENGTH ? undefined : path;
}

/**
 * A return path as a URL to go to: pages get the current locale prefix, as the router's rewrite
 * gives links (an `href` redirect or navigation bypasses it); `/oauth` and the other unprefixed
 * paths stay as they are.
 */
export function localizedReturnHref(path: string): string {
  const { pathname } = new URL(path, "http://localhost");
  return isNonLocalizedPath(pathname) ? path : localizeHref(path);
}

/** Why a sign-in that left the page (for GitHub) sent the person back to it: they refused on
 * GitHub, it did not work, or too many attempts came from their address. */
export const SIGN_IN_ERRORS = ["github_denied", "github_failed", "rate_limited"] as const;
export type SignInError = (typeof SIGN_IN_ERRORS)[number];

/** The `error` of a sign-in page URL, or `undefined` when it names none of `SIGN_IN_ERRORS`. */
export function readSignInError(value: unknown): SignInError | undefined {
  return SIGN_IN_ERRORS.find((error) => error === value);
}

/** The `prompt` of a sign-in URL: `"login"`, the one value that means anything, or `undefined`. */
export function readPrompt(value: unknown): "login" | undefined {
  return value === "login" ? "login" : undefined;
}

/** The sign-in page, coming back to `returnTo` (a `safeReturnTo` path) afterwards. `prompt:
 * "login"` has the page ask for the password even when the person already has a session (Login
 * with CoForge's `prompt=login` and `max_age`, and a session whose user no longer exists). `error`
 * has the page say why a sign-in that left it did not complete. */
export function signInHref(
  returnTo: string | undefined,
  { prompt, error }: { prompt?: "login"; error?: SignInError } = {},
): string {
  const query = new URLSearchParams();
  if (returnTo) query.set("returnTo", returnTo);
  if (prompt) query.set("prompt", prompt);
  if (error) query.set("error", error);
  return withQuery("/login", query);
}

/** The way out to GitHub (`/auth/github`), which comes back to the sign-in page with the same
 * `returnTo` and `prompt` (see `signInHref`). */
export function githubSignInHref(
  returnTo: string | undefined,
  prompt: "login" | undefined,
): string {
  const query = new URLSearchParams();
  if (returnTo) query.set("returnTo", returnTo);
  if (prompt) query.set("prompt", prompt);
  return withQuery("/auth/github", query);
}

/** Signs out, then straight back to sign-in and `returnTo` (switching account). */
export function signOutHref(returnTo: string | undefined): string {
  return withQuery("/auth/logout", new URLSearchParams(returnTo ? { returnTo } : {}));
}

/** `encodeURIComponent` encoding, as these links have always been written. */
function withQuery(path: string, query: URLSearchParams): string {
  const pairs = [...query].map(([name, value]) => `${name}=${encodeURIComponent(value)}`);
  return pairs.length ? `${path}?${pairs.join("&")}` : path;
}

/** Where a person lands once a sign-in step is done: the page they were going to (a `safeReturnTo`
 * path) with the locale prefix pages carry, else the app's own start page. */
export function afterSignInHref(returnTo: string | undefined): string {
  return returnTo ? localizedReturnHref(returnTo) : localizeHref("/");
}

/** Where a sign-in that just finished goes next, the one rule every way of signing in shares: the
 * name step for an account that has not finished first sign-in (`welcomed` false), else the page
 * `returnTo` names, or the start page. `returnTo` is what the browser sent and is judged here
 * (`safeReturnTo`), so nothing but a page of this site comes out. */
export function nextHrefAfterSignIn(welcomed: boolean, returnTo: unknown): string {
  const page = safeReturnTo(returnTo);
  return welcomed ? afterSignInHref(page) : welcomeHref(page);
}

/** The first-sign-in name step, coming back to `returnTo` (a `safeReturnTo` path) once the person
 * has answered. Localized like any page, for a redirect that bypasses the router's rewrite. */
export function welcomeHref(returnTo: string | undefined): string {
  return localizedReturnHref(
    returnTo ? `/welcome?returnTo=${encodeURIComponent(returnTo)}` : "/welcome",
  );
}

/** The invite token when `returnTo` is a join page (`/join/<token>`, with or without a locale
 * prefix, any query), else `undefined`. Only the shape is read: whether the link works is for the
 * server to find out. */
export function joinTokenFromReturnTo(returnTo: unknown): string | undefined {
  const path = safeReturnTo(returnTo);
  if (!path) return undefined;
  const { pathname } = new URL(deLocalizeHref(path), SAME_SITE_BASE);
  const match = /^\/join\/([^/]+)\/?$/.exec(pathname);
  if (!match?.[1]) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}
