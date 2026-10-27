import { expect, spyOn, test } from "bun:test";

import type { AuthingAuthentication } from "#src/server/auth/authing-authentication.server";
import { signInThroughAuthing } from "#src/server/auth/authing-sign-in.server";
import { NO_SIGN_IN_RATE_LIMITS } from "#src/server/auth/sign-in-rate-limits.server";

// CoForge keeps its own session, so Authing's token is revoked once a sign-in has it: whatever
// happens after the tokens are obtained, and without the person waiting for Authing to answer.

const accessToken = "access-token-secret-9c1d";

function authingStub(options: { revokeToken?: AuthingAuthentication["revokeToken"] } = {}) {
  const revoked: string[] = [];
  const authing = {
    async fetchUserInfo() {
      return { sub: "authing-user-1", email: "ada@example.com", name: "Ada" };
    },
    async revokeToken(token: string) {
      revoked.push(token);
      await options.revokeToken?.(token);
    },
  } as unknown as AuthingAuthentication;
  return { authing, revoked };
}

async function signIn(
  authing: AuthingAuthentication,
  extra: Partial<Parameters<typeof signInThroughAuthing>[0]> = {},
) {
  const spies = [
    spyOn(console, "error").mockImplementation(() => undefined),
    spyOn(console, "warn").mockImplementation(() => undefined),
  ];
  try {
    return await signInThroughAuthing({
      stage: "password_sign_in",
      authenticate: async () => ({ accessToken }),
      authing,
      sessionSecret: "test-session-secret-at-least-32-characters",
      secure: false,
      rateLimits: NO_SIGN_IN_RATE_LIMITS,
      resolveUser: async () => ({
        id: "user-1",
        username: "ada",
        displayName: "Ada Lovelace",
        welcomedAt: new Date("2026-10-01T00:00:00Z"),
      }),
      ...extra,
    });
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

test("a sign-in does not wait for Authing to revoke the token", async () => {
  const { authing, revoked } = authingStub({ revokeToken: () => new Promise(() => undefined) });
  const result = await signIn(authing);
  expect(result.status).toBe("signed_in");
  expect(revoked).toEqual([accessToken]);
});

test("the token is revoked when the person cannot be resolved because the database is down", async () => {
  const previous = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const { authing, revoked } = authingStub();
    const result = await signIn(authing, { resolveUser: undefined });
    expect(result).toEqual({ status: "failed" });
    expect(revoked).toEqual([accessToken]);
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
});

test("the token is revoked when the profile cannot be read or the person resolved", async () => {
  const unreadable = authingStub();
  unreadable.authing.fetchUserInfo = async () => {
    throw new Error("userinfo is down");
  };
  expect((await signIn(unreadable.authing)).status).toBe("failed");
  expect(unreadable.revoked).toEqual([accessToken]);

  const unresolved = authingStub();
  const result = await signIn(unresolved.authing, {
    resolveUser: async () => {
      throw new Error("database error");
    },
  });
  expect(result.status).toBe("failed");
  expect(unresolved.revoked).toEqual([accessToken]);
});

test("a revocation that fails is logged without the token and does not fail the sign-in", async () => {
  const warnings: string[] = [];
  const spy = spyOn(console, "warn").mockImplementation((line: unknown) => {
    warnings.push(String(line));
  });
  try {
    const { authing } = authingStub({
      revokeToken: async () => {
        throw new Error(`refused ${accessToken}`);
      },
    });
    const result = await signInThroughAuthing({
      stage: "password_sign_in",
      authenticate: async () => ({ accessToken }),
      authing,
      sessionSecret: "test-session-secret-at-least-32-characters",
      secure: false,
      rateLimits: NO_SIGN_IN_RATE_LIMITS,
      resolveUser: async () => ({
        id: "user-1",
        username: "ada",
        displayName: "Ada Lovelace",
        welcomedAt: null,
      }),
    });
    expect(result.status).toBe("signed_in");
    // The revocation runs in the background: wait for its log line.
    for (let wait = 0; wait < 100 && warnings.length === 0; wait++) await Bun.sleep(10);
    expect(warnings.map((line) => JSON.parse(line))).toEqual([
      { event: "auth.token_revocation_failed", errorType: "Error" },
    ]);
    expect(warnings.join("\n")).not.toContain(accessToken);
  } finally {
    spy.mockRestore();
  }
});
