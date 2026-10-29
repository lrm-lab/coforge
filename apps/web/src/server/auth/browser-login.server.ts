import { initialDisplayName } from "#src/features/auth/name-prefill";
import { e164Phone } from "#src/features/auth/code-destination";
import type { AuthingAuthentication, AuthingTokens } from "./authing-authentication.server";
import { atSignInStage } from "./login-failure.server";
import { readSignedValue as readSigned, signValue as sign } from "./signed-value.server";
export type BrowserUser = {
  id: string;
  /** What the provider reported, trimmed and lower-cased. An account made with a phone number
   * alone has none; the user is identified by `(provider, sub)`, never by this. */
  email: string | null;
  /** What the provider reported as the person's name (else its nickname), trimmed; empty when it
   * reported neither. It only starts the first-sign-in name field: a person is named by their
   * stored `displayName` (`humanLabel`), never by this. */
  name: string;
  authingSub: string;
  username: string;
};
export type InternalUserResolver = (input: {
  provider: string;
  subject: string;
  email: string | null;
  /** The provider's phone number in E.164 (`+8613800138000`), when it reported a usable one. */
  phone?: string;
  preferredUsername?: string;
  /** What the provider reported as the person's name, for a username when nothing better names them. */
  name?: string;
  nickname?: string;
}) => Promise<{
  id: string;
  username: string;
  /** The person's stored display name; every account has one. */
  displayName: string;
  /** When the person finished first sign-in; null sends them to it. */
  welcomedAt: Date | null;
}>;

const SESSION_COOKIE = "coforge_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14;

type SignedSession = BrowserUser & { exp: number; authTime?: number };

/**
 * Turns the tokens of a sign-in Authing completed into a CoForge session: reads the profile they
 * name, resolves (and on a first sign-in creates) the person, and signs the session cookie. The
 * tail every way of signing in shares.
 */
export async function completeBrowserLogin(input: {
  sessionSecret: string;
  tokens: AuthingTokens;
  authing: Pick<AuthingAuthentication, "fetchUserInfo">;
  /** Whether the site is served over HTTPS, which the cookie then requires. */
  secure: boolean;
  resolveUser?: InternalUserResolver;
  now?: () => number;
}): Promise<{
  user: BrowserUser;
  /** The person's stored display name; every account has one. */
  displayName: string;
  /** Whether the person finished first sign-in; when not, sign-in continues at the name step
   * rather than creating anything for them. */
  welcomed: boolean;
  sessionCookie: string;
}> {
  const now = input.now ?? Date.now;
  const { tokens } = input;
  const profile = await atSignInStage("userinfo", () =>
    input.authing.fetchUserInfo(tokens.accessToken),
  );
  const email = profile.email?.trim().toLowerCase() || null;
  // Only a number this platform can use *and* Authing says it verified is stored: an unverified
  // number is one the person typed into their own account, so it must never match a platform
  // operator. A missing claim reads as unverified.
  const verifiedPhone = profile.phone_number_verified === true || profile.phone_verified === true;
  const phone = verifiedPhone
    ? (e164Phone(profile.phone_number ?? profile.phone ?? "") ?? undefined)
    : undefined;
  const { resolveUser } = input;
  const resolved = resolveUser
    ? await atSignInStage("user_resolution", () =>
        resolveUser({
          provider: "authing",
          subject: profile.sub,
          email,
          ...(phone ? { phone } : {}),
          ...(profile.preferred_username ? { preferredUsername: profile.preferred_username } : {}),
          ...(profile.name?.trim() ? { name: profile.name.trim() } : {}),
          ...(profile.nickname?.trim() ? { nickname: profile.nickname.trim() } : {}),
        }),
      )
    : {
        id: testOnlyStableInternalUserId("authing", profile.sub),
        username: `user-${testOnlyStableInternalUserId("authing", profile.sub).replaceAll("-", "")}`,
        displayName: initialDisplayName({ name: profile.name, nickname: profile.nickname, email }),
        welcomedAt: null,
      };
  const user: BrowserUser = {
    id: resolved.id,
    username: resolved.username,
    email,
    name: profile.name?.trim() || profile.nickname?.trim() || "",
    authingSub: profile.sub,
  };
  const session: SignedSession = {
    ...user,
    // The password was just checked: the sign-in is now.
    authTime: Math.floor(now() / 1000),
    exp: Math.floor(now() / 1000) + SESSION_TTL_SECONDS,
  };
  return {
    user,
    displayName: resolved.displayName,
    welcomed: resolved.welcomedAt !== null,
    sessionCookie: serializeCookie(
      SESSION_COOKIE,
      sign("session", session, input.sessionSecret),
      SESSION_TTL_SECONDS,
      input.secure,
    ),
  };
}

// The real sign-in supplies the persistence resolver. This deterministic fallback
// keeps the pure authentication seam usable without a database in unit tests.
function testOnlyStableInternalUserId(provider: string, subject: string): string {
  const bytes = Array.from(sha256Bytes(`coforge-internal-user:${provider}:${subject}`));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** A signed-in person and when they signed in (epoch seconds, OIDC `auth_time`). */
export type BrowserSignIn = { user: BrowserUser; authTime: number };

export function readBrowserSession(input: {
  sessionSecret: string;
  cookieHeader: string;
  now?: () => number;
}): BrowserUser | null {
  return readBrowserSignIn(input)?.user ?? null;
}

/** The session's person and sign-in time, or null without a valid session. A session signed
 * before sign-in times were kept counts from when it was issued. */
export function readBrowserSignIn(input: {
  sessionSecret: string;
  cookieHeader: string;
  now?: () => number;
}): BrowserSignIn | null {
  const now = input.now ?? Date.now;
  const session = readSigned<SignedSession>(
    "session",
    readCookie(input.cookieHeader, SESSION_COOKIE),
    input.sessionSecret,
  );
  if (!isSignedSession(session) || session.exp * 1000 <= now()) return null;
  const { id, email, name, authingSub, username, authTime } = session;
  return {
    user: { id, email, name, authingSub, username },
    authTime: typeof authTime === "number" ? authTime : session.exp - SESSION_TTL_SECONDS,
  };
}

/** The cookie that ends a session: CoForge's session is all there is to end, since sign-in keeps
 * no Authing token (`signInWithPassword` revokes it once the profile is read). */
export function sessionEndingCookie(secure: boolean): string {
  return clearCookie(SESSION_COOKIE, secure);
}

/** Whether a signed session carries every field a `BrowserUser` needs; `id` goes straight into
 * queries, where `undefined` would match every row. */
function isSignedSession(value: SignedSession | null): value is SignedSession {
  return (
    value !== null &&
    typeof value.exp === "number" &&
    [value.id, value.name, value.authingSub, value.username].every(
      (field) => typeof field === "string",
    ) &&
    // A session made before an email became optional carries a string; a new one may carry null.
    (typeof value.email === "string" || value.email === null) &&
    value.id !== ""
  );
}

/** The value of the cookie `name` in a `Cookie` header, or null. */
export function readCookie(header: string, name: string): string | null {
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

/** A `Set-Cookie` value for a path-wide HttpOnly cookie that browsers send on top-level
 * navigations from other sites (`SameSite=Lax`), as a return from GitHub is. */
export function serializeCookie(
  name: string,
  value: string,
  maxAgeSeconds: number,
  secure: boolean,
): string {
  return [
    `${name}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

/** A `Set-Cookie` value that expires the cookie `name`. */
export function clearCookie(name: string, secure: boolean): string {
  return serializeCookie(name, "", 0, secure);
}

function sha256Bytes(value: string): Uint8Array {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(value);
  return new Uint8Array(hasher.digest());
}
