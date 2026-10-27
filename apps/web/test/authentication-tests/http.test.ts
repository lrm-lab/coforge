import { expect, test } from "bun:test";

import { completeBrowserLogin } from "#src/server/auth/browser-login.server";
import { handleCurrentUser, handleLogout } from "#src/server/auth/http.server";

const sessionSecret = "test-session-secret-at-least-32-characters";

async function signedIn() {
  return completeBrowserLogin({
    sessionSecret,
    tokens: { accessToken: "authing-access" },
    authing: {
      async fetchUserInfo() {
        return { sub: "authing-user-1", email: "ada@example.com", name: "Ada" };
      },
    },
    secure: false,
  });
}

function cookieOf(setCookie: string): string {
  return setCookie.split(";", 1)[0] ?? "";
}

function cookies(response: Response): string[] {
  return response.headers.getSetCookie();
}

test("current user is unauthorized without a session", () => {
  const response = handleCurrentUser({
    request: new Request("http://localhost:3000/api/me"),
    sessionSecret,
  });
  expect(response.status).toBe(401);
});

test("current user returns the signed-in CoForge user, and nothing of Authing's tokens", async () => {
  const completed = await signedIn();
  const response = handleCurrentUser({
    request: new Request("http://localhost:3000/api/me", {
      headers: { cookie: cookieOf(completed.sessionCookie) },
    }),
    sessionSecret,
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toEqual({ user: completed.user });
  expect(JSON.stringify(body)).not.toContain("authing-access");
});

test("logout expires the session cookie and goes to sign-in", () => {
  const response = handleLogout({ origin: "https://coforge.cn" });
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("/login");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(cookies(response)).toHaveLength(1);
  expect(cookies(response)[0]).toStartWith("coforge_session=;");
  expect(cookies(response)[0]).toContain("Max-Age=0");
  expect(cookies(response)[0]).toContain("Secure");
});

test("logout comes back to sign-in for a page of this site, and only one", () => {
  const to = (returnTo: string | null | undefined) =>
    handleLogout({ origin: "http://localhost:3000", returnTo }).headers.get("location");
  expect(to("/join/abc")).toBe("/login?returnTo=%2Fjoin%2Fabc");
  for (const unsafe of [undefined, null, "", "//evil.com", "https://evil.com", "/\\evil"]) {
    expect(to(unsafe)).toBe("/login");
  }
});
