import { afterAll, beforeAll, expect, test } from "bun:test";
import { isRedirect } from "@tanstack/react-router";
import { optionalBrowserSignIn, requireBrowserSignIn } from "#src/server/auth/require-user.server";
import { signValue } from "#src/server/auth/signed-value.server";
import {
  recordDatabaseQuery,
  withServerTiming,
} from "#src/server/observability/server-timing.server";

// Only a request that required a signed-in person and had one gets Server-Timing. Sessions are
// read with the deployment's secret, from the environment, as every request does.
const enabled = { COFORGE_SERVER_TIMING: "1" };
const sessionSecret = "server-timing-test-secret-at-least-32-characters";
const authEnv = ["COFORGE_SESSION_SECRET", "COFORGE_SESSION_SECRET_FILE", "COFORGE_DEV_SKIP_AUTH"];
const previousEnv = Object.fromEntries(authEnv.map((name) => [name, process.env[name]]));
beforeAll(() => {
  for (const name of authEnv) delete process.env[name];
  process.env.COFORGE_SESSION_SECRET = sessionSecret;
});
afterAll(() => {
  for (const [name, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/** A `Cookie` header with a session signed with `secret`, as sign-in sets it. */
function sessionCookie({ secret = sessionSecret, expiresInSeconds = 3600 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const session = {
    id: "0199e8a1-0000-7000-8000-000000000001",
    email: null,
    name: "Signed In",
    authingSub: "authing-sub",
    username: "signed-in",
    authTime: now,
    exp: now + expiresInSeconds,
  };
  return `coforge_session=${signValue("session", session, secret)}`;
}

/** A Server Function call or a page render whose handler runs `work` with the request's cookie,
 * then answers; a redirect to sign-in is the answer a signed-out caller gets. */
function timed(handlerType: "serverFn" | "router", cookie: string | undefined, work: Work) {
  return withServerTiming(
    handlerType,
    async () => {
      recordDatabaseQuery(0, 5);
      try {
        await work(cookie);
      } catch (error) {
        if (!isRedirect(error)) throw error;
        return { response: new Response(null, { status: 307 }) };
      }
      const type = handlerType === "router" ? "text/html" : "application/json";
      return { response: new Response("{}", { headers: { "content-type": type } }) };
    },
    enabled,
  );
}
type Work = (cookie: string | undefined) => Promise<unknown>;

/** What `authMiddleware` and a page's guard do: require the signed-in person. */
const requiresSignIn: Work = (cookie) => requireBrowserSignIn(cookie, "/w/team");
/** What sign-in and password reset do: nothing with the caller's session. */
const openToAnyone: Work = async () => {};
/** What an endpoint open to anyone does when it only adapts to a signed-in caller. */
const readsSignInIfAny: Work = (cookie) => optionalBrowserSignIn(cookie);

test("a signed-in person's request that required sign-in carries total and db, nothing else", async () => {
  for (const handlerType of ["serverFn", "router"] as const) {
    const { response } = await timed(handlerType, sessionCookie(), requiresSignIn);
    const value = response.headers.get("server-timing") ?? "";
    expect(value).toMatch(/^total;dur=\d+(\.\d+)?, db;dur=5$/);
  }
});

test("a signed-in person calling sign-in or password reset gets no header", async () => {
  for (const work of [openToAnyone, readsSignInIfAny]) {
    for (const handlerType of ["serverFn", "router"] as const) {
      const { response } = await timed(handlerType, sessionCookie(), work);
      expect(response.headers.has("server-timing")).toBe(false);
    }
  }
});

test("a request without a valid session gets no header, wherever it goes", async () => {
  const cookies = [
    undefined,
    sessionCookie({ secret: "x".repeat(40) }),
    sessionCookie({ expiresInSeconds: -1 }),
    "coforge_session=not-a-session",
  ];
  for (const cookie of cookies) {
    for (const work of [requiresSignIn, openToAnyone, readsSignInIfAny]) {
      const { response } = await timed("serverFn", cookie, work);
      expect(response.headers.has("server-timing")).toBe(false);
    }
  }
});

test("without a session secret configured, nobody is signed in and nothing is timed", async () => {
  delete process.env.COFORGE_SESSION_SECRET;
  try {
    const { response } = await timed("serverFn", sessionCookie(), requiresSignIn);
    expect(response.status).toBe(307);
    expect(response.headers.has("server-timing")).toBe(false);
  } finally {
    process.env.COFORGE_SESSION_SECRET = sessionSecret;
  }
});
