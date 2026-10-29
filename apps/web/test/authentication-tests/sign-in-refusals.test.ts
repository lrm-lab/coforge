import { expect, test } from "bun:test";

import {
  InvalidCredentialsError,
  passwordRefusal,
  type AuthingAuthentication,
  type PasswordRefusal,
} from "#src/server/auth/authing-authentication.server";
import { signInThroughAuthing } from "#src/server/auth/authing-sign-in.server";

/**
 * What a refused password sign-in tells the page, from Authing's `apiCode`
 * (https://docs.authing.cn/v2/reference/error-code.html). A wrong password and an account that
 * does not exist stay one answer; the rest name themselves.
 */
test("Authing's apiCode decides what the page is told", () => {
  const cases: [string, PasswordRefusal][] = [
    ["2006", "credentials"], // password is wrong
    ["2004", "credentials"], // the user does not exist
    ["2027", "no_password"], // registered through OAuth, no password set
    ["2005", "locked"],
    ["2000", "code_required"],
    ["2002", "quota"],
    ["2011", "misconfigured"],
    ["2036", "misconfigured"],
    ["9999", "credentials"], // an apiCode we do not know stays a plain refusal
  ];
  for (const [apiCode, refusal] of cases) expect(passwordRefusal(apiCode)).toBe(refusal);
  expect(passwordRefusal(undefined)).toBe("credentials");
});

/** A sign-in whose only step is Authing refusing what was typed. */
async function refused(providerError: string) {
  const authing = {
    async signInWithPassword() {
      throw new InvalidCredentialsError(400, providerError, "password_sign_in");
    },
    async revokeToken() {},
  } as unknown as AuthingAuthentication;
  return signInThroughAuthing({
    stage: "password_sign_in",
    authenticate: () => authing.signInWithPassword({ email: "a@b.c", password: "x" }),
    authing,
    sessionSecret: "test-session-secret-at-least-32-characters",
    secure: false,
  });
}

test("each refusal reaches the page as its own status", async () => {
  expect((await refused("2027")).status).toBe("no_password");
  expect((await refused("2005")).status).toBe("account_locked");
  expect((await refused("2000")).status).toBe("code_required");
  expect((await refused("2002")).status).toBe("login_quota_exhausted");
  expect((await refused("2011")).status).toBe("login_unavailable");
  // The two that must never be told apart.
  expect((await refused("2006")).status).toBe("invalid_credentials");
  expect((await refused("2004")).status).toBe("invalid_credentials");
  expect((await refused("9999")).status).toBe("invalid_credentials");
});
