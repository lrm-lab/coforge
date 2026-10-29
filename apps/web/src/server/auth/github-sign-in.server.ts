import { randomBytes, timingSafeEqual } from "node:crypto";

import { readPrompt, safeReturnTo, type SignInError } from "#src/features/auth/return-to";
import { createAuthingAuthentication, type AuthingConfig } from "./authing-authentication.server";
import { signInThroughAuthing, type SignInUseCaseInput } from "./authing-sign-in.server";
import { clearCookie, readCookie, serializeCookie } from "./browser-login.server";
import type { GitHubSignInConfig } from "./config.server";
import { reportGitHubSignInRejected } from "./login-failure.server";
import { readSignedValue, signValue } from "./signed-value.server";

/**
 * Signing in with GitHub, which the browser does by leaving for GitHub's authorize page and coming
 * back to `/auth/github/callback` with a code (https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps).
 * CoForge never exchanges that code itself: Authing does, through its GitHub connection, and the
 * rest is the sign-in every method shares (`signInThroughAuthing`). The browser holds what ties the
 * way back to the way out: a short-lived signed cookie with the `state` GitHub returns.
 */
export const GITHUB_SIGN_IN_CALLBACK_PATH = "/auth/github/callback";
export const GITHUB_SIGN_IN_COOKIE = "coforge_github_sign_in";

/** What GitHub is asked for: the profile and the verified emails Authing reads. */
const GITHUB_SCOPE = "read:user user:email";
/** How long a person has to authorize on GitHub. */
const STATE_TTL_SECONDS = 10 * 60;
/** GitHub's codes are 20 characters; anything long is not one. */
const MAX_CODE_LENGTH = 256;

type PendingSignIn = { state: string; returnTo?: string; prompt?: "login"; exp: number };

/** Where to send the browser to authorize, and the cookie that remembers the way back. */
export function startGitHubSignIn(input: {
  config: GitHubSignInConfig;
  sessionSecret: string;
  /** The origin the browser reached, whose callback path GitHub is sent back to. */
  origin: string;
  /** The page to go to once signed in (a `safeReturnTo` path). */
  returnTo: string | undefined;
  /** `"login"` when the sign-in page was asked to sign the person in afresh (`prompt=login`): the
   * way back to it keeps asking. */
  prompt?: "login" | undefined;
  now?: () => number;
}): { location: string; cookie: string } {
  const state = randomBytes(32).toString("base64url");
  const pending: PendingSignIn = {
    state,
    ...(input.returnTo ? { returnTo: input.returnTo } : {}),
    ...(input.prompt ? { prompt: input.prompt } : {}),
    exp: Math.floor((input.now ?? Date.now)() / 1000) + STATE_TTL_SECONDS,
  };
  const location = new URL(input.config.authorizeUrl);
  location.searchParams.set("client_id", input.config.clientId);
  location.searchParams.set("redirect_uri", `${input.origin}${GITHUB_SIGN_IN_CALLBACK_PATH}`);
  location.searchParams.set("scope", GITHUB_SCOPE);
  location.searchParams.set("state", state);
  return {
    location: location.toString(),
    cookie: serializeCookie(
      GITHUB_SIGN_IN_COOKIE,
      signValue("github-sign-in", pending, input.sessionSecret),
      STATE_TTL_SECONDS,
      input.origin.startsWith("https:"),
    ),
  };
}

export type GitHubSignInResult =
  | {
      status: "signed_in";
      sessionCookie: string;
      /** Whether the person finished first sign-in; when not, the name step comes next. */
      welcomed: boolean;
      returnTo: string | undefined;
    }
  /** The sign-in did not complete; the person goes back to the sign-in page, which says why. */
  | {
      status: "back";
      error: SignInError;
      returnTo: string | undefined;
      prompt?: "login";
    };

/**
 * Finishes the sign-in the browser returned from GitHub for. `query` is the callback's, and
 * `cookieHeader` the request's: the cookie `startGitHubSignIn` set must be there, signed, unexpired,
 * and hold the `state` GitHub returned, or nobody is signed in and Authing is not asked. A refusal
 * on GitHub's page is `github_denied`. The attempt counts against the client address alone: no
 * account is known before Authing has exchanged the code. `signInThroughAuthing` logs a failure.
 */
export async function completeGitHubSignIn(
  input: SignInUseCaseInput & {
    query: URLSearchParams;
    cookieHeader: string;
    config: GitHubSignInConfig;
    authingConfig: AuthingConfig;
  },
): Promise<GitHubSignInResult> {
  const now = input.now ?? Date.now;
  const pending = readSignedValue<PendingSignIn>(
    "github-sign-in",
    readCookie(input.cookieHeader, GITHUB_SIGN_IN_COOKIE),
    input.sessionSecret,
  );
  const live =
    pending && typeof pending.state === "string" && pending.exp * 1000 > now() ? pending : null;
  const returnTo = live ? safeReturnTo(live.returnTo) : undefined;
  const prompt = readPrompt(live?.prompt);
  const back = (error: SignInError): GitHubSignInResult => ({
    status: "back",
    error,
    returnTo,
    ...(prompt ? { prompt } : {}),
  });

  const state = input.query.get("state");
  if (!live || !state || !sameText(state, live.state)) {
    reportGitHubSignInRejected("state");
    return back("github_failed");
  }
  const refusal = input.query.get("error");
  if (refusal) {
    reportGitHubSignInRejected(refusal === "access_denied" ? "denied" : "error");
    return back(refusal === "access_denied" ? "github_denied" : "github_failed");
  }
  const code = input.query.get("code");
  if (!code || code.length > MAX_CODE_LENGTH) {
    reportGitHubSignInRejected("no_code");
    return back("github_failed");
  }

  const authing = input.authing ?? createAuthingAuthentication(input.authingConfig);
  const result = await signInThroughAuthing({
    stage: "github_sign_in",
    authenticate: () => authing.signInWithGitHubCode({ code, connection: input.config.connection }),
    authing,
    sessionSecret: input.sessionSecret,
    secure: input.secure,
    clientAddress: input.clientAddress,
    resolveUser: input.resolveUser,
    now: input.now,
  });
  if (result.status === "signed_in") {
    return {
      status: "signed_in",
      sessionCookie: result.sessionCookie,
      welcomed: result.welcomed,
      returnTo,
    };
  }
  return back("github_failed");
}

/** The `Set-Cookie` that ends a sign-in's state: it is good for one return from GitHub. */
export function githubSignInEndingCookie(secure: boolean): string {
  return clearCookie(GITHUB_SIGN_IN_COOKIE, secure);
}

/** Whether two strings are equal, in time that does not depend on where they differ. */
function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
