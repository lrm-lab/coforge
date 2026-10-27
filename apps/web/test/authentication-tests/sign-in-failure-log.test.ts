import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";

import type { AuthingConfig } from "#src/server/auth/authing-authentication.server";
import { reportSignInFailure } from "#src/server/auth/login-failure.server";
import { NO_SIGN_IN_RATE_LIMITS } from "#src/server/auth/sign-in-rate-limits.server";
import { signInWithPassword } from "#src/server/auth/password-sign-in.server";

// A failed sign-in tells the browser only that it failed. The operator's only account of why is the
// log line, so it must name the step and the non-secret reason, and never carry anything a sign-in
// is made of: the password, the email, a token, the app secret.

const sessionSecret = "test-session-secret-at-least-32-characters";
const appSecret = "test-app-secret";
const password = "password-secret-7f3a";
const accessToken = "access-token-secret-9c1d";
const email = "ada@example.com";
const baseConfig: AuthingConfig = {
  appId: "6a8fde6fa804dd3bea560bac",
  appSecret,
  appHost: "https://coforge.authing.cn",
  userinfoEndpoint: "https://coforge.authing.cn/oidc/me",
  revocationEndpoint: "https://coforge.authing.cn/oidc/token/revocation",
};

type FakeAuthing = { signIn?: () => Response; userinfo?: () => Response };

const servers: Array<ReturnType<typeof Bun.serve>> = [];

// A shell that enables detailed server-error logging would print exception messages these tests
// assert never reach the log, so the variable is cleared for each test and restored after it.
let logServerErrors: string | undefined;
beforeEach(() => {
  logServerErrors = process.env.COFORGE_LOG_SERVER_ERRORS;
  delete process.env.COFORGE_LOG_SERVER_ERRORS;
});

afterEach(async () => {
  if (logServerErrors === undefined) delete process.env.COFORGE_LOG_SERVER_ERRORS;
  else process.env.COFORGE_LOG_SERVER_ERRORS = logServerErrors;
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
});

/** A real HTTP Authing, so the sign-in runs the client it ships with. */
function authingAt(routes: FakeAuthing): AuthingConfig {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      const respond = pathname === "/api/v3/signin" ? routes.signIn : routes.userinfo;
      return respond ? respond() : new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  return {
    ...baseConfig,
    appHost: server.url.origin,
    userinfoEndpoint: `${server.url}me`,
  };
}

const signedIn = () =>
  Response.json({ statusCode: 200, message: "ok", data: { access_token: accessToken } });
const userinfoOk = () =>
  Response.json({ sub: "authing-user-1", email, name: "Ada", preferred_username: "ada" });

type Attempt = {
  config?: AuthingConfig;
  resolveUser?: () => Promise<{
    id: string;
    username: string;
    displayName: string;
    welcomedAt: Date | null;
  }>;
  /** Leaves user resolution to the database sign-in ships with. */
  persisted?: boolean;
};

async function attempt(options: Attempt = {}) {
  const errors: string[] = [];
  const warnings: string[] = [];
  const errorSpy = spyOn(console, "error").mockImplementation((line: unknown) => {
    errors.push(String(line));
  });
  const warnSpy = spyOn(console, "warn").mockImplementation((line: unknown) => {
    warnings.push(String(line));
  });
  let result: Awaited<ReturnType<typeof signInWithPassword>>;
  try {
    result = await signInWithPassword({
      config: options.config ?? baseConfig,
      sessionSecret,
      secure: false,
      credentials: { email, password },
      rateLimits: NO_SIGN_IN_RATE_LIMITS,
      ...(options.persisted
        ? {}
        : {
            resolveUser:
              options.resolveUser ??
              (async () => ({
                id: "user-1",
                username: "ada",
                displayName: "Ada Lovelace",
                welcomedAt: new Date("2026-10-01T00:00:00Z"),
              })),
          }),
    });
  } finally {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  }
  // Everything a sign-in is made of, none of which may reach a log.
  const secrets = [password, appSecret, accessToken, email, sessionSecret];
  return { result, errors, warnings, secrets };
}

function records(lines: string[]): Array<Record<string, unknown>> {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function signInFailure(lines: string[]): Record<string, unknown> {
  const found = records(lines).filter((record) => record.event === "auth.sign_in_failed");
  expect(found).toHaveLength(1);
  return found[0] ?? {};
}

function expectNoSecrets(lines: string[], secrets: string[]) {
  const logged = lines.join("\n");
  for (const secret of secrets) expect(logged).not.toContain(secret);
}

test("a refused email and password is a result, logged with Authing's codes and nothing typed", async () => {
  const config = authingAt({
    signIn: () =>
      Response.json({
        statusCode: 400,
        apiCode: 2333,
        message: `wrong password ${password} for ${email}`,
      }),
  });
  const { result, errors, warnings, secrets } = await attempt({ config });
  expect(result).toEqual({ status: "invalid_credentials" });
  expect(errors).toEqual([]);
  expect(records(warnings)).toEqual([
    { event: "auth.sign_in_rejected", statusCode: 400, providerError: "2333" },
  ]);
  expectNoSecrets([...errors, ...warnings], secrets);
});

test("a refusal Authing sends with an HTTP 4xx is a refusal too", async () => {
  const config = authingAt({
    signIn: () => Response.json({ statusCode: 401, message: "no" }, { status: 401 }),
  });
  expect((await attempt({ config })).result).toEqual({ status: "invalid_credentials" });
});

test("an Authing that fails says the password sign-in failed, with its status and code", async () => {
  const config = authingAt({
    signIn: () =>
      Response.json({ statusCode: 500, apiCode: 1000, message: "boom" }, { status: 500 }),
  });
  const { result, errors, secrets } = await attempt({ config });
  expect(result).toEqual({ status: "failed" });
  expect(errors).toHaveLength(1);
  expect(signInFailure(errors)).toEqual({
    event: "auth.sign_in_failed",
    stage: "password_sign_in",
    reason: "Authing did not complete the password sign-in",
    status: 500,
    providerError: "1000",
  });
  expectNoSecrets(errors, secrets);
});

test("a server error reported inside an HTTP 200 is a failure, not a wrong password", async () => {
  const config = authingAt({
    signIn: () => Response.json({ statusCode: 500, message: "boom" }),
  });
  expect((await attempt({ config })).result).toEqual({ status: "failed" });
});

test("a sign-in answered 200 without a token is a failure, not a wrong password", async () => {
  const config = authingAt({ signIn: () => Response.json({ statusCode: 200, data: {} }) });
  const { result, errors } = await attempt({ config });
  expect(result).toEqual({ status: "failed" });
  expect(signInFailure(errors)).toMatchObject({ stage: "password_sign_in", status: 200 });
});

test("an Authing that is not answering with JSON still says its status", async () => {
  const config = authingAt({
    signIn: () => new Response("<html>bad gateway</html>", { status: 502 }),
  });
  const { result, errors, secrets } = await attempt({ config });
  expect(result).toEqual({ status: "failed" });
  expect(signInFailure(errors)).toEqual({
    event: "auth.sign_in_failed",
    stage: "password_sign_in",
    reason: "Authing did not complete the password sign-in",
    status: 502,
  });
  expectNoSecrets(errors, secrets);
});

test("an error code that could carry something else is not logged as Authing's code", async () => {
  const config = authingAt({
    signIn: () =>
      Response.json(
        { statusCode: 500, apiCode: `bad ${password} ${accessToken}` },
        { status: 500 },
      ),
  });
  const { errors, secrets } = await attempt({ config });
  expect(signInFailure(errors)).toEqual({
    event: "auth.sign_in_failed",
    stage: "password_sign_in",
    reason: "Authing did not complete the password sign-in",
    status: 500,
  });
  expectNoSecrets(errors, secrets);
});

test("an Authing that cannot be reached says the password sign-in failed, without the request", async () => {
  const gone = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const config = { ...baseConfig, appHost: gone.url.origin };
  await gone.stop(true);
  const { result, errors, secrets } = await attempt({ config });
  expect(result).toEqual({ status: "failed" });
  const failure = signInFailure(errors);
  expect(failure).toMatchObject({
    event: "auth.sign_in_failed",
    stage: "password_sign_in",
    reason: "Authing did not complete the password sign-in",
    errorType: expect.any(String),
    errorId: expect.any(String),
  });
  expect(failure).not.toHaveProperty("status");
  expectNoSecrets(errors, secrets);
});

test("a userinfo request Authing refuses says userinfo failed, with the status", async () => {
  const config = authingAt({
    signIn: signedIn,
    userinfo: () => Response.json({ error: "invalid_token" }, { status: 401 }),
  });
  const { result, errors, secrets } = await attempt({ config });
  expect(result).toEqual({ status: "failed" });
  expect(errors).toHaveLength(1);
  expect(signInFailure(errors)).toEqual({
    event: "auth.sign_in_failed",
    stage: "userinfo",
    reason: "failed to fetch Authing user info",
    status: 401,
  });
  expectNoSecrets(errors, secrets);
});

test("a user that cannot be resolved says so, without the error's message or the email in it", async () => {
  const config = authingAt({ signIn: signedIn, userinfo: userinfoOk });
  const { result, errors, secrets } = await attempt({
    config,
    resolveUser: async () => {
      throw new Error(`duplicate key value violates unique constraint for ${email}`);
    },
  });
  expect(result).toEqual({ status: "failed" });
  const failure = signInFailure(errors);
  expect(failure).toEqual({
    event: "auth.sign_in_failed",
    stage: "user_resolution",
    reason: "failed to resolve user",
    errorType: "error",
    errorId: expect.any(String),
  });
  // The exception itself stays where it always was: the generic line with the same errorId.
  expect(
    records(errors).find((record) => record.event === "server_operation_failed"),
  ).toMatchObject({ errorId: failure.errorId });
  expectNoSecrets(errors, secrets);
  expect(errors.join("\n")).not.toContain("duplicate key");
});

test("a database that is missing says so as the step that needed it", async () => {
  const previous = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const config = authingAt({ signIn: signedIn, userinfo: userinfoOk });
    const { result, errors, secrets } = await attempt({ config, persisted: true });
    expect(result).toEqual({ status: "failed" });
    expect(signInFailure(errors)).toEqual({
      event: "auth.sign_in_failed",
      stage: "user_resolution",
      reason: "database is unavailable",
    });
    expectNoSecrets(errors, secrets);
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
});

test("an error the sign-in did not classify is logged as unexpected, carrying none of its message", () => {
  // The catch-all for a throw that no step wrapped; drive the reporter directly, which is where its
  // contract lives, and assert both halves - the step is named, and the exception's own text never
  // reaches the log.
  const message = `boom for ${email} carrying ${accessToken} and ${appSecret}`;
  const lines: string[] = [];
  const spy = spyOn(console, "error").mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
  try {
    reportSignInFailure(new Error(message));
  } finally {
    spy.mockRestore();
  }
  const failure = signInFailure(lines);
  expect(failure).toEqual({
    event: "auth.sign_in_failed",
    stage: "unexpected",
    reason: "unexpected error",
    errorType: "error",
    errorId: expect.any(String),
  });
  expect(records(lines).find((record) => record.event === "server_operation_failed")).toMatchObject(
    { errorId: failure.errorId },
  );
  expectNoSecrets(lines, [email, accessToken, appSecret]);
  expect(lines.join("\n")).not.toContain("boom for");
});
