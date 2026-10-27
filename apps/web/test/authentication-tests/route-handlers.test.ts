import { expect, test } from "bun:test";

import { currentUserHandler, logoutHandler } from "#src/server/auth/route-handlers.server";

test("logout signs out without any Authing config: it needs none", () => {
  const previous = {
    AUTHING_APP_ID: process.env.AUTHING_APP_ID,
    AUTHING_APP_SECRET: process.env.AUTHING_APP_SECRET,
    AUTHING_ISSUER: process.env.AUTHING_ISSUER,
    COFORGE_SESSION_SECRET: process.env.COFORGE_SESSION_SECRET,
  };
  delete process.env.AUTHING_APP_ID;
  delete process.env.AUTHING_APP_SECRET;
  delete process.env.AUTHING_ISSUER;
  delete process.env.COFORGE_SESSION_SECRET;

  try {
    const response = logoutHandler({
      request: new Request("http://localhost:3000/auth/logout"),
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/login");
    expect(response.headers.getSetCookie()[0]).toContain("Max-Age=0");
  } finally {
    restoreEnv(previous);
  }
});

test("current user returns a safe 503 when the session secret is missing", async () => {
  const previous = process.env.COFORGE_SESSION_SECRET;
  delete process.env.COFORGE_SESSION_SECRET;
  try {
    const response = await currentUserHandler({
      request: new Request("http://localhost:3000/api/me"),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "TEMPORARILY_UNAVAILABLE" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  } finally {
    if (previous === undefined) delete process.env.COFORGE_SESSION_SECRET;
    else process.env.COFORGE_SESSION_SECRET = previous;
  }
});

test("behind the proxy, sign-out expires a Secure cookie and returns to sign-in on the same site", async () => {
  const previous = {
    AUTHING_APP_ID: process.env.AUTHING_APP_ID,
    AUTHING_APP_SECRET: process.env.AUTHING_APP_SECRET,
    AUTHING_ISSUER: process.env.AUTHING_ISSUER,
    COFORGE_SESSION_SECRET: process.env.COFORGE_SESSION_SECRET,
  };
  process.env.AUTHING_APP_ID = "6a8fde6fa804dd3bea560bac";
  process.env.AUTHING_APP_SECRET = "test-app-secret";
  process.env.AUTHING_ISSUER = "https://coforge.authing.cn/oidc";
  process.env.COFORGE_SESSION_SECRET = "test-session-secret-at-least-32-characters";

  try {
    const logout = await logoutHandler({
      request: new Request("http://staging.coforge.cn/auth/logout?returnTo=/join/abc", {
        headers: { "x-forwarded-proto": "https", "x-forwarded-host": "staging.coforge.cn" },
      }),
    });
    expect(logout.headers.get("location")).toBe("/login?returnTo=%2Fjoin%2Fabc");
    const cookies = logout.headers.getSetCookie();
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toContain("; Secure");
  } finally {
    restoreEnv(previous);
  }
});

function restoreEnv(values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
