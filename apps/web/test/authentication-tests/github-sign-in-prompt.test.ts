import { expect, test } from "bun:test";

import type { GitHubSignInConfig } from "#src/server/auth/config.server";
import { completeGitHubSignIn, startGitHubSignIn } from "#src/server/auth/github-sign-in.server";

// A person sent to /login?prompt=login (Login with CoForge asking for a fresh sign-in) who goes out
// to GitHub must come back to a sign-in page that still asks for one, not on to the page they were
// going to: the prompt travels in the signed state cookie, and every way back keeps it.

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

function start(prompt: "login" | undefined) {
  const { location, cookie } = startGitHubSignIn({
    config,
    sessionSecret,
    origin: "https://coforge.test",
    returnTo: "/oidc/auth?client_id=a",
    prompt,
  });
  return {
    state: new URL(location).searchParams.get("state")!,
    cookieHeader: cookie.split(";")[0]!,
  };
}

function comeBack(started: ReturnType<typeof start>, query: Record<string, string>) {
  return completeGitHubSignIn({
    query: new URLSearchParams({ state: started.state, ...query }),
    cookieHeader: started.cookieHeader,
    config,
    authingConfig,
    sessionSecret,
    secure: true,
  });
}

test("a refusal on GitHub's page sends the person back to a sign-in that still asks for one", async () => {
  expect(await comeBack(start("login"), { error: "access_denied" })).toEqual({
    status: "back",
    error: "github_denied",
    returnTo: "/oidc/auth?client_id=a",
    prompt: "login",
  });
});

test("a GitHub error and a missing code keep the prompt too", async () => {
  const started = start("login");
  expect(await comeBack(started, { error: "server_error" })).toMatchObject({
    error: "github_failed",
    prompt: "login",
  });
  expect(await comeBack(started, {})).toMatchObject({ error: "github_failed", prompt: "login" });
});

test("a sign-in that did not ask for one comes back without the prompt", async () => {
  const result = await comeBack(start(undefined), { error: "access_denied" });
  expect(result).toEqual({
    status: "back",
    error: "github_denied",
    returnTo: "/oidc/auth?client_id=a",
  });
  expect(result).not.toHaveProperty("prompt");
});
