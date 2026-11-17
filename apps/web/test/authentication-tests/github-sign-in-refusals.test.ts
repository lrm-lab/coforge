import { afterEach, expect, test } from "bun:test";

import type { GitHubSignInConfig } from "#src/server/auth/config.server";
import { completeGitHubSignIn, startGitHubSignIn } from "#src/server/auth/github-sign-in.server";
import {
  githubSignInCallbackHandler,
  githubSignInStartHandler,
} from "#src/server/auth/github-sign-in-http.server";

// The ways back from GitHub that are refused before Authing is asked anything, and a deployment
// without GitHub sign-in. The browser e2e (e2e-github-sign-in) keeps the round trips that need
// GitHub's page and Authing; these are decided here.

const sessionSecret = "test-session-secret-at-least-32-characters";
const config: GitHubSignInConfig = {
  clientId: "e2e-client",
  connection: "github-mobile",
  authorizeUrl: "https://github.com/login/oauth/authorize",
};
const authingConfig = {
  appId: "app",
  appSecret: "secret",
  appHost: "http://127.0.0.1:1",
  userinfoEndpoint: "http://127.0.0.1:1/oidc/me",
  revocationEndpoint: "http://127.0.0.1:1/oidc/token/revocation",
};
const returnTo = "/w/acme/channel/general";

/** Authing that fails the test if it is asked anything. */
const untouchedAuthing = new Proxy(
  {},
  {
    get(_, name) {
      throw new Error(`Authing was asked ${String(name)}`);
    },
  },
) as NonNullable<Parameters<typeof completeGitHubSignIn>[0]["authing"]>;

function started() {
  const { location, cookie } = startGitHubSignIn({
    config,
    sessionSecret,
    origin: "https://coforge.test",
    returnTo,
  });
  return {
    state: new URL(location).searchParams.get("state")!,
    cookieHeader: cookie.split(";")[0]!,
  };
}

function comeBack(cookieHeader: string, query: Record<string, string>) {
  return completeGitHubSignIn({
    query: new URLSearchParams(query),
    cookieHeader,
    config,
    authingConfig,
    sessionSecret,
    secure: true,
    authing: untouchedAuthing,
  });
}

test("a state other than the browser's, or none, is refused before Authing is asked", async () => {
  const { cookieHeader } = started();
  const queries: Record<string, string>[] = [
    { state: "tampered-state", code: "abc" },
    { code: "abc" },
  ];
  for (const query of queries)
    expect(await comeBack(cookieHeader, query)).toEqual({
      status: "back",
      error: "github_failed",
      returnTo,
    });
});

test("a callback with no start of ours is refused the same way", async () => {
  expect(await comeBack("", { state: "abc", code: "abc" })).toEqual({
    status: "back",
    error: "github_failed",
    returnTo: undefined,
  });
});

test("refusing on GitHub's page says so, and Authing is not asked", async () => {
  const { state, cookieHeader } = started();
  expect(await comeBack(cookieHeader, { state, error: "access_denied" })).toEqual({
    status: "back",
    error: "github_denied",
    returnTo,
  });
});

const githubEnv = ["COFORGE_GITHUB_SIGN_IN_CLIENT_ID", "AUTHING_GITHUB_CONNECTION"] as const;
const saved = githubEnv.map((name) => [name, process.env[name]] as const);
afterEach(() => {
  for (const [name, value] of saved)
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
});

test("a deployment without GitHub sign-in answers both routes with 404", async () => {
  for (const name of githubEnv) process.env[name] = "";
  const start = await githubSignInStartHandler({
    request: new Request("https://coforge.test/auth/github"),
  });
  const callback = await githubSignInCallbackHandler({
    request: new Request("https://coforge.test/auth/github/callback?code=x&state=y"),
  });
  expect([start.status, callback.status]).toEqual([404, 404]);
});
