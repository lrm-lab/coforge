import { expect, test } from "bun:test";

import {
  localizedReturnHref,
  nextHrefAfterSignIn,
  safeReturnTo,
  signInHref,
  signOutHref,
} from "#src/features/auth/return-to";

test("a same-site page path is a place to return to after signing in", () => {
  expect(safeReturnTo("/w/x/channel/1?view=chat")).toBe("/w/x/channel/1?view=chat");
  expect(safeReturnTo("/join/abc")).toBe("/join/abc");
  expect(safeReturnTo("/oauth/verify?user_code=AB-CD")).toBe("/oauth/verify?user_code=AB-CD");
});

test("anything that could leave CoForge is not a place to return to", () => {
  for (const value of [
    "//evil.com",
    "https://evil.com",
    "/\\evil",
    "javascript:alert(1)",
    "",
    "w/x",
    // Browsers drop tabs and newlines from URLs, which would turn this into `//evil.com`.
    "/\t/evil.com",
    "/\n/evil.com",
    undefined,
    42,
  ]) {
    expect(safeReturnTo(value)).toBeUndefined();
  }
});

test("a page path with non-ASCII characters comes back percent-encoded, so it fits a Location header", () => {
  expect(safeReturnTo("/oauth/verify?x=项")).toBe("/oauth/verify?x=%E9%A1%B9");
  expect(safeReturnTo("/w/acme/项目")).toBe("/w/acme/%E9%A1%B9%E7%9B%AE");
  expect(() => new Headers({ location: safeReturnTo("/oauth/verify?x=项")! })).not.toThrow();
});

test("dot segments that would resolve to another host are not a place to return to", () => {
  expect(safeReturnTo("/.//evil.com")).toBeUndefined();
  expect(safeReturnTo("/a/..//evil.com")).toBeUndefined();
  expect(safeReturnTo("/w/acme/../../join/abc")).toBe("/join/abc");
});

test("a return path long enough to overflow the sign-in cookie is dropped", () => {
  expect(safeReturnTo(`/w/acme/${"a".repeat(2_041)}`)).toBeUndefined();
  expect(safeReturnTo(`/w/acme/${"a".repeat(2_040)}`)).toHaveLength(2_048);
  expect(safeReturnTo(`/w/acme/${"a".repeat(1_000)}`)).toBe(`/w/acme/${"a".repeat(1_000)}`);
});

test("the page to return to keeps the locale prefix CoForge pages carry, and none on /oauth", () => {
  expect(localizedReturnHref("/w/x/channel/1?view=chat")).toBe("/en/w/x/channel/1?view=chat");
  expect(localizedReturnHref("/oauth/verify?user_code=AB-CD")).toBe(
    "/oauth/verify?user_code=AB-CD",
  );
});

test("signing in starts at /login and carries the page to come back to", () => {
  expect(signInHref("/oauth/verify?user_code=AB-CD")).toBe(
    "/login?returnTo=%2Foauth%2Fverify%3Fuser_code%3DAB-CD",
  );
  expect(signInHref(undefined)).toBe("/login");
});

test("signing in again asks for prompt=login, and signing out can come back to sign in", () => {
  expect(signInHref("/oidc/auth?client_id=a", { prompt: "login" })).toBe(
    "/login?returnTo=%2Foidc%2Fauth%3Fclient_id%3Da&prompt=login",
  );
  expect(signOutHref("/oidc/auth?client_id=a")).toBe(
    "/auth/logout?returnTo=%2Foidc%2Fauth%3Fclient_id%3Da",
  );
  expect(signOutHref(undefined)).toBe("/auth/logout");
});

test("a Login with CoForge authorization request comes back unchanged and unprefixed", () => {
  const request =
    "/oidc/auth?client_id=acme-notes&redirect_uri=https%3A%2F%2Fnotes.acme.example%2Fcb" +
    "&response_type=code&scope=openid+profile&state=a%2Fb&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256";
  expect(safeReturnTo(request)).toBe(request);
  expect(localizedReturnHref(request)).toBe(request);
  // The app's redirect URI travels inside the query; it never becomes where sign-in returns to.
  expect(safeReturnTo("//notes.acme.example/oidc/auth?client_id=acme-notes")).toBeUndefined();
  expect(safeReturnTo("/\\notes.acme.example/oidc/auth")).toBeUndefined();
});

test("a finished sign-in goes on to the page asked for, or the name step first for a new account", () => {
  expect(nextHrefAfterSignIn(true, "/w/x/channel/1")).toBe("/en/w/x/channel/1");
  expect(nextHrefAfterSignIn(true, undefined)).toBe("/en");
  expect(nextHrefAfterSignIn(false, "/join/abc")).toBe("/en/welcome?returnTo=%2Fjoin%2Fabc");
  expect(nextHrefAfterSignIn(false, undefined)).toBe("/en/welcome");
  // What the browser sent is judged here, so no caller can forget to: nothing leaves the site.
  expect(nextHrefAfterSignIn(true, "//evil.com")).toBe("/en");
  expect(nextHrefAfterSignIn(false, "https://evil.com")).toBe("/en/welcome");
  expect(nextHrefAfterSignIn(true, "/oauth/verify?user_code=AB-CD")).toBe(
    "/oauth/verify?user_code=AB-CD",
  );
});
