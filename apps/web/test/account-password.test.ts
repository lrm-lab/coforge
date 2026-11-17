import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import {
  accountContactDestination,
  sendAccountPasswordCode,
  setAccountPassword,
} from "#src/server/auth/account-password.server";
import { normalizePasswordAccount } from "#src/server/auth/password-sign-in.server";
import type { AuthingConfig } from "#src/server/auth/authing-authentication.server";

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
});

function fakeAuthingServer(handlers: {
  onSend?: (path: string, body: Record<string, unknown>) => Response;
  onVerify?: (body: Record<string, unknown>) => Response;
  onReset?: (body: Record<string, unknown>) => Response;
  onSignIn?: (body: Record<string, unknown>) => void;
  signInSub?: string;
  signInStatus?: number;
}) {
  const revokedTokens: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === "/oidc/me") {
        return Response.json({ sub: handlers.signInSub ?? "authing-sub-1" });
      }
      if (pathname === "/oidc/token/revocation") {
        const form = new URLSearchParams(await request.text());
        const tok = form.get("token");
        if (tok) revokedTokens.push(tok);
        return new Response(null, { status: 200 });
      }
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      if (pathname === "/api/v3/send-email" || pathname === "/api/v3/send-sms") {
        return (
          handlers.onSend?.(pathname, body) ?? Response.json({ statusCode: 200, message: "ok" })
        );
      }
      if (pathname === "/api/v3/verify-reset-password-request") {
        return (
          handlers.onVerify?.(body) ??
          Response.json({ statusCode: 200, data: { passwordResetToken: "rt-1" } })
        );
      }
      if (pathname === "/api/v3/reset-password") {
        return handlers.onReset?.(body) ?? Response.json({ statusCode: 200, message: "ok" });
      }
      if (pathname === "/api/v3/signin") {
        handlers.onSignIn?.(body);
        if (handlers.signInStatus && handlers.signInStatus !== 200) {
          return new Response("upstream error", { status: handlers.signInStatus });
        }
        return Response.json({
          statusCode: 200,
          data: {
            access_token: "verify-sub-access-tok",
            id_token: "id-1",
            token_type: "Bearer",
            expire_in: 3600,
          },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  const config: AuthingConfig = {
    appId: "test-app",
    appSecret: "test-secret",
    appHost: server.url.origin,
    userinfoEndpoint: `${server.url.origin}/oidc/me`,
    revocationEndpoint: `${server.url.origin}/oidc/token/revocation`,
  };
  return { config, revokedTokens };
}

type FakeUser = {
  email: string | null;
  emailVerified: boolean | null;
  phone: string | null;
  phoneVerified: boolean | null;
  authingSub?: string;
};

function fakeDb(users: Record<string, FakeUser>): PrismaClient {
  return {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const u = users[where.id];
        if (!u) return null;
        return {
          email: u.email,
          emailVerified: u.emailVerified,
          phone: u.phone,
          phoneVerified: u.phoneVerified,
          identities: u.authingSub ? [{ providerSubject: u.authingSub }] : [],
        };
      },
    },
  } as unknown as PrismaClient;
}

describe("accountContactDestination", () => {
  test("uses only the account's own verified email", () => {
    expect(
      accountContactDestination(
        { email: " Ada@EXAMPLE.com ", emailVerified: true, phone: null, phoneVerified: null },
        "email",
      ),
    ).toEqual({
      kind: "email",
      email: "ada@example.com",
    });
  });

  test("normalizes the account's own verified mainland phone", () => {
    expect(
      accountContactDestination(
        { email: null, emailVerified: null, phone: "+8613800138000", phoneVerified: true },
        "phone",
      ),
    ).toEqual({
      kind: "phone",
      countryCode: "+86",
      phone: "13800138000",
    });
  });

  test("rejects unverified or missing contacts", () => {
    expect(
      accountContactDestination(
        { email: "ada@example.com", emailVerified: false, phone: null, phoneVerified: null },
        "email",
      ),
    ).toBeNull();
    expect(
      accountContactDestination(
        {
          email: "ada@example.com",
          emailVerified: null,
          phone: "+8613800138000",
          phoneVerified: false,
        },
        "phone",
      ),
    ).toBeNull();
    expect(
      accountContactDestination(
        { email: null, emailVerified: null, phone: null, phoneVerified: null },
        "email",
      ),
    ).toBeNull();
  });
});

describe("sendAccountPasswordCode & setAccountPassword", () => {
  test("refuses with no_contact when the account lacks the requested verified contact", async () => {
    let called = false;
    const { config } = fakeAuthingServer({
      onSend: () => {
        called = true;
        return Response.json({ statusCode: 200 });
      },
    });
    const db = fakeDb({
      "u-1": {
        email: "ada@example.com",
        emailVerified: true,
        phone: "+8613800138000",
        phoneVerified: false,
        authingSub: "authing-sub-1",
      },
    });

    const sendRes = await sendAccountPasswordCode({
      db,
      userId: "u-1",
      contact: "phone",
      config,
    });
    expect(sendRes).toEqual({ status: "no_contact" });

    const setRes = await setAccountPassword({
      db,
      userId: "u-1",
      contact: "phone",
      passCode: "123456",
      newPassword: "correct-horse-battery",
      config,
    });
    expect(setRes).toEqual({ status: "no_contact" });
    expect(called).toBe(false);
  });

  test("sends reset code only to own verified email, sets password, verifies sub, and revokes token", async () => {
    const sent: Array<{ path: string; body: Record<string, unknown> }> = [];
    const verified: Array<Record<string, unknown>> = [];
    const resetCalls: Array<Record<string, unknown>> = [];
    const { config, revokedTokens } = fakeAuthingServer({
      signInSub: "authing-sub-1",
      onSend: (path, body) => {
        sent.push({ path, body });
        return Response.json({ statusCode: 200, message: "ok" });
      },
      onVerify: (body) => {
        verified.push(body);
        return Response.json({ statusCode: 200, data: { passwordResetToken: "reset-tok-1" } });
      },
      onReset: (body) => {
        resetCalls.push(body);
        return Response.json({ statusCode: 200, message: "ok" });
      },
    });
    const db = fakeDb({
      "u-1": {
        email: "Ada@Example.com",
        emailVerified: true,
        phone: "+8613800138000",
        phoneVerified: true,
        authingSub: "authing-sub-1",
      },
    });

    const sendRes = await sendAccountPasswordCode({
      db,
      userId: "u-1",
      contact: "email",
      config,
    });
    expect(sendRes).toEqual({ status: "sent" });
    expect(sent).toEqual([
      {
        path: "/api/v3/send-email",
        body: { channel: "CHANNEL_RESET_PASSWORD", email: "ada@example.com" },
      },
    ]);

    const setRes = await setAccountPassword({
      db,
      userId: "u-1",
      contact: "email",
      passCode: "654321",
      newPassword: "new-strong-password-1",
      config,
    });
    expect(setRes).toEqual({ status: "updated" });
    expect(verified).toEqual([
      {
        verifyMethod: "EMAIL_PASSCODE",
        emailPassCodePayload: { email: "ada@example.com", passCode: "654321" },
      },
    ]);
    expect(resetCalls).toEqual([
      { passwordResetToken: "reset-tok-1", password: "new-strong-password-1" },
    ]);
    expect(revokedTokens).toEqual(["verify-sub-access-tok"]);
  });

  test("returns identity_mismatch, logs warning, and revokes token if reset hit a different authingSub", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { config, revokedTokens } = fakeAuthingServer({
        signInSub: "someone-elses-sub",
      });
      const db = fakeDb({
        "u-1": {
          email: "shared@example.com",
          emailVerified: true,
          phone: null,
          phoneVerified: null,
          authingSub: "my-own-sub",
        },
      });

      const setRes = await setAccountPassword({
        db,
        userId: "u-1",
        contact: "email",
        passCode: "654321",
        newPassword: "new-strong-password-1",
        config,
      });
      expect(setRes).toEqual({ status: "identity_mismatch" });
      expect(revokedTokens).toEqual(["verify-sub-access-tok"]);
      expect(warnSpy.mock.calls.flat().join("\n")).toContain("auth.account_password_sub_mismatch");
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("returns updated_unverified and logs failure without password when post-reset sign-in fails", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const secretPassword = "new-strong-password-never-log";
      const { config } = fakeAuthingServer({ signInStatus: 503 });
      const db = fakeDb({
        "u-1": {
          email: "ada@example.com",
          emailVerified: true,
          phone: null,
          phoneVerified: null,
          authingSub: "my-own-sub",
        },
      });

      const setRes = await setAccountPassword({
        db,
        userId: "u-1",
        contact: "email",
        passCode: "654321",
        newPassword: secretPassword,
        config,
      });
      expect(setRes).toEqual({ status: "updated_unverified" });
      const logs = [...warnSpy.mock.calls, ...errorSpy.mock.calls].flat().join("\n");
      expect(logs).toContain("auth.sign_in_failed");
      expect(logs).not.toContain("auth.account_password_sub_mismatch");
      expect(logs).not.toContain(secretPassword);
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  test("passes 11-digit phone without +86 to Authing password verification and normalizes +86 on login", async () => {
    const signInBodies: Array<Record<string, unknown>> = [];
    const { config } = fakeAuthingServer({
      signInSub: "authing-sub-phone",
      onSignIn: (body) => signInBodies.push(body),
    });
    const db = fakeDb({
      "u-phone": {
        email: null,
        emailVerified: null,
        phone: "+8613800138000",
        phoneVerified: true,
        authingSub: "authing-sub-phone",
      },
    });

    const res = await setAccountPassword({
      db,
      userId: "u-phone",
      contact: "phone",
      passCode: "123456",
      newPassword: "new-strong-password-1",
      config,
    });
    expect(res).toEqual({ status: "updated" });
    expect(signInBodies).toEqual([
      expect.objectContaining({
        connection: "PASSWORD",
        passwordPayload: { account: "13800138000", password: "new-strong-password-1" },
      }),
    ]);

    expect(normalizePasswordAccount("+8613800138000")).toBe("13800138000");
    expect(normalizePasswordAccount("138-0013-8000")).toBe("13800138000");
    expect(normalizePasswordAccount("ada@example.com")).toBe("ada@example.com");
    expect(normalizePasswordAccount("ada_lovelace")).toBe("ada_lovelace");
  });
});
