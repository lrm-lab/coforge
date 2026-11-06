import { describe, expect, spyOn, test } from "bun:test";
import {
  CodeSendRefusedError,
  CodeSendThrottledError,
  createAuthingAuthentication,
  type AuthingAuthentication,
  type AuthingConfig,
} from "#src/server/auth/authing-authentication.server";
import { requestEmailVerification } from "#src/server/auth/email-verification.server";
import type { VerifyEmailRateLimits } from "#src/server/auth/sign-in-rate-limits.server";

const config: AuthingConfig = {
  appId: "app-id",
  appSecret: "app-secret",
  appHost: "https://authing.example.com",
  userinfoEndpoint: "https://authing.example.com/oidc/me",
  revocationEndpoint: "https://authing.example.com/oidc/token/revocation",
};

const unlimited: VerifyEmailRateLimits = {
  user: { admit: async () => ({ allowed: true }) },
};
const limited: VerifyEmailRateLimits = {
  user: { admit: async () => ({ allowed: false, retryAfterSeconds: 30 }) },
};

function authingSpy() {
  const calls: string[] = [];
  const authing = {
    sendVerifyEmailLink: async (email: string) => {
      calls.push(email);
    },
  } as unknown as AuthingAuthentication;
  return { calls, authing };
}

const unverified = { email: "ada@example.com", emailVerified: false };

describe("requestEmailVerification", () => {
  test("sends the link to the account's own stored address", async () => {
    const { calls, authing } = authingSpy();
    const result = await requestEmailVerification({
      profile: unverified,
      userId: "user-1",
      config,
      rateLimits: unlimited,
      authing,
    });
    expect(result).toEqual({ status: "sent" });
    expect(calls).toEqual(["ada@example.com"]);
  });

  test("an already verified account is sent nothing", async () => {
    const { calls, authing } = authingSpy();
    const result = await requestEmailVerification({
      profile: { email: "ada@example.com", emailVerified: true },
      userId: "user-1",
      config,
      rateLimits: unlimited,
      authing,
    });
    expect(result).toEqual({ status: "already_verified" });
    expect(calls).toEqual([]);
  });

  test("an account with no address is sent nothing", async () => {
    const { calls, authing } = authingSpy();
    for (const email of [null, "", "   "]) {
      const result = await requestEmailVerification({
        profile: { email, emailVerified: null },
        userId: "user-1",
        config,
        rateLimits: unlimited,
        authing,
      });
      expect(result).toEqual({ status: "no_email" });
    }
    expect(calls).toEqual([]);
  });

  test("the per-user limit refuses before Authing is called", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { calls, authing } = authingSpy();
      const result = await requestEmailVerification({
        profile: unverified,
        userId: "user-1",
        config,
        rateLimits: limited,
        authing,
      });
      expect(result).toEqual({ status: "rate_limited" });
      expect(calls).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  test("Authing's own throttle maps to rate_limited", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const authing = {
        sendVerifyEmailLink: async () => {
          throw new CodeSendThrottledError("2333");
        },
      } as unknown as AuthingAuthentication;
      const result = await requestEmailVerification({
        profile: unverified,
        userId: "user-1",
        config,
        rateLimits: unlimited,
        authing,
      });
      expect(result).toEqual({ status: "rate_limited" });
    } finally {
      warn.mockRestore();
    }
  });

  test("any other failure is logged and answered failed", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const authing = {
        sendVerifyEmailLink: async () => {
          throw new CodeSendRefusedError(400, "2036");
        },
      } as unknown as AuthingAuthentication;
      const result = await requestEmailVerification({
        profile: unverified,
        userId: "user-1",
        config,
        rateLimits: unlimited,
        authing,
      });
      expect(result).toEqual({ status: "failed" });
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});

describe("sendVerifyEmailLink", () => {
  function jsonResponse(statusCode: number, status = 200) {
    return new Response(JSON.stringify({ statusCode, data: {} }), { status });
  }

  test("posts the verify-link channel and the address to send-email", async () => {
    const spy = spyOn(globalThis, "fetch").mockImplementation((async () =>
      jsonResponse(200)) as never);
    try {
      await createAuthingAuthentication(config).sendVerifyEmailLink("ada@example.com");
      expect(spy).toHaveBeenCalledTimes(1);
      const [url, init] = spy.mock.calls[0]! as unknown as [string, RequestInit];
      expect(url).toBe("https://authing.example.com/api/v3/send-email");
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>)["x-authing-app-id"]).toBe("app-id");
      expect(JSON.parse(String(init.body))).toEqual({
        channel: "CHANNEL_VERIFY_EMAIL_LINK",
        email: "ada@example.com",
      });
    } finally {
      spy.mockRestore();
    }
  });

  test("a too-frequent refusal is the throttle, a refusal is a refusal", async () => {
    const throttled = spyOn(globalThis, "fetch").mockImplementation((async () =>
      jsonResponse(200, 429)) as never);
    try {
      await expect(
        createAuthingAuthentication(config).sendVerifyEmailLink("ada@example.com"),
      ).rejects.toBeInstanceOf(CodeSendThrottledError);
    } finally {
      throttled.mockRestore();
    }
    const refused = spyOn(globalThis, "fetch").mockImplementation((async () =>
      jsonResponse(400, 400)) as never);
    try {
      await expect(
        createAuthingAuthentication(config).sendVerifyEmailLink("ada@example.com"),
      ).rejects.toBeInstanceOf(CodeSendRefusedError);
    } finally {
      refused.mockRestore();
    }
  });
});
