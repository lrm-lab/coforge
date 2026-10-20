import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";

import {
  completeBrowserLogin,
  readBrowserSignIn,
  startBrowserLogin,
  type TokenExchanger,
} from "#src/server/auth/browser-login.server";
import { handleLoginStart } from "#src/server/auth/http.server";

/**
 * When a person last signed in, and signing in again on request: the session keeps the sign-in
 * time Authing reports (OIDC `auth_time`), and `/auth/login?prompt=login` makes Authing ask again
 * (OIDC Core §3.1.2.1) — what Login with CoForge needs for `prompt=login` and `max_age`.
 */

const sessionSecret = "test-session-secret-at-least-32-characters";
const config = {
  appId: "6a8fde6fa804dd3bea560bac",
  appSecret: "test-app-secret",
  issuer: "https://coforge.authing.cn/oidc",
  authorizationEndpoint: "https://coforge.authing.cn/oidc/auth",
  tokenEndpoint: "https://coforge.authing.cn/oidc/token",
  userinfoEndpoint: "https://coforge.authing.cn/oidc/me",
  endSessionEndpoint: "https://coforge.authing.cn/oidc/session/end",
  redirectUri: "http://localhost:3000/auth/callback",
};
const NOW_MS = 1_760_000_000_000;
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14;

/** An unsigned JWT with these claims: the callback reads the ID token it got from Authing's token
 * endpoint over TLS, which OIDC Core §3.1.3.7 lets it trust without checking the signature. */
const idToken = (claims: Record<string, unknown>) =>
  [{ alg: "RS256" }, claims]
    .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
    .concat("signature")
    .join(".");

function authing(token: string | undefined): TokenExchanger {
  return {
    async exchangeAuthorizationCode() {
      return { accessToken: "access", ...(token ? { idToken: token } : {}) };
    },
    async fetchUserInfo() {
      return { sub: "authing-ada", email: "ada@example.com", name: "Ada" };
    },
  };
}

/** Signs in through a fake Authing that returns `token`, and reads the session back. */
async function signIn(token: string | undefined) {
  const started = startBrowserLogin({ config, sessionSecret, now: () => NOW_MS });
  const state = new URL(started.authorizationUrl).searchParams.get("state")!;
  const completed = await completeBrowserLogin({
    config,
    sessionSecret,
    code: "code",
    state,
    cookieHeader: started.stateCookie.split(";", 1)[0]!,
    authing: authing(token),
    now: () => NOW_MS,
  });
  return readBrowserSignIn({
    sessionSecret,
    cookieHeader: completed.sessionCookie.split(";", 1)[0]!,
    now: () => NOW_MS,
  })?.authTime;
}

test("a sign-in that asks again sends Authing prompt=login and max_age=0", () => {
  const response = handleLoginStart({
    config,
    sessionSecret,
    returnTo: "/oidc/auth?client_id=acme",
    prompt: "login",
  });
  const upstream = new URL(response.headers.get("location")!);
  expect(upstream.searchParams.get("prompt")).toBe("login");
  expect(upstream.searchParams.get("max_age")).toBe("0");
});

test("an ordinary sign-in, or any other prompt value, asks Authing for nothing more", () => {
  for (const prompt of [undefined, null, "none", "consent", "login consent"]) {
    const response = handleLoginStart({ config, sessionSecret, prompt });
    const upstream = new URL(response.headers.get("location")!);
    expect(upstream.searchParams.has("prompt")).toBe(false);
    expect(upstream.searchParams.has("max_age")).toBe(false);
  }
});

test("the session keeps the sign-in time from Authing's ID token", async () => {
  const authTime = NOW_MS / 1000 - 3_600;
  expect(await signIn(idToken({ sub: "authing-ada", auth_time: authTime }))).toBe(authTime);
});

test("without a usable auth_time the session counts the sign-in as now", async () => {
  for (const token of [undefined, "not-a-jwt", idToken({ sub: "authing-ada", auth_time: "soon" })])
    expect(await signIn(token)).toBe(NOW_MS / 1000);
});

test("a session signed before sign-in times were kept counts from when it was issued", () => {
  const exp = NOW_MS / 1000 + 3_600;
  const body = Buffer.from(
    JSON.stringify({
      id: "00000000-0000-7000-8000-000000000001",
      email: "ada@example.com",
      name: "Ada",
      authingSub: "authing-ada",
      username: "ada",
      exp,
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", sessionSecret)
    .update(`session.${body}`)
    .digest("base64url");
  const authTime = readBrowserSignIn({
    sessionSecret,
    cookieHeader: `coforge_session=${body}.${signature}`,
    now: () => NOW_MS,
  })?.authTime;
  expect(authTime).toBe(exp - SESSION_TTL_SECONDS);
});
