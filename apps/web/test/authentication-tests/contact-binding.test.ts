import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import type { AuthingConfig } from "#src/server/auth/authing-authentication.server";
import {
  bindAccountContact,
  CONTACT_BIND_COOKIE,
  CONTACT_BIND_TTL_SECONDS,
  contactBindCookie,
  contactBindEndingCookie,
  MemoryContactBindStore,
  sendContactBindCode,
  stageGitHubContactBind,
} from "#src/server/auth/contact-binding.server";
import {
  completeGitHubSignIn,
  GITHUB_SIGN_IN_COOKIE,
  startGitHubSignIn,
} from "#src/server/auth/github-sign-in.server";
import { getCodeSendRateLimits } from "#src/server/auth/sign-in-rate-limits.server";

const SESSION_SECRET = "test-session-secret-at-least-32-characters";
const GITHUB_CONFIG = {
  clientId: "gh-client",
  connection: "github-conn",
  authorizeUrl: "https://github.com/login/oauth/authorize",
};

const servers: Array<ReturnType<typeof Bun.serve>> = [];

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

function fakeAuthingServer(options: {
  accessToken?: string;
  sub?: string;
  boundEmail?: string;
  boundPhone?: string;
  bindStatusCode?: number;
  sendStatus?: number;
  failUserInfoWith?: string;
}) {
  const token = options.accessToken ?? "authing-user-token-secret-xyz";
  const sub = options.sub ?? "authing-sub-1";
  const revokedTokens: string[] = [];
  const sendAuthHeaders: Array<string | null> = [];
  const bindCalls: Array<{ path: string; auth: string | null; body: Record<string, unknown> }> = [];
  let currentEmail: string | undefined;
  let currentPhone: string | undefined;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === "/api/v3/signin-by-mobile") {
        return Response.json({
          statusCode: 200,
          data: { access_token: token, id_token: "id-1", token_type: "Bearer", expire_in: 3600 },
        });
      }
      if (pathname === "/oidc/me") {
        if (options.failUserInfoWith) {
          throw new Error(options.failUserInfoWith);
        }
        return Response.json({
          sub,
          email: currentEmail,
          email_verified: currentEmail ? true : undefined,
          phone_number: currentPhone,
          phone_number_verified: currentPhone ? true : undefined,
        });
      }
      if (pathname === "/oidc/token/revocation") {
        const form = new URLSearchParams(await request.text());
        const rev = form.get("token");
        if (rev) revokedTokens.push(rev);
        return new Response(null, { status: 200 });
      }
      if (pathname === "/api/v3/send-sms" || pathname === "/api/v3/send-email") {
        sendAuthHeaders.push(request.headers.get("authorization"));
        if (options.sendStatus && options.sendStatus !== 200) {
          return Response.json({ statusCode: options.sendStatus, message: "send error" });
        }
        return Response.json({ statusCode: 200, message: "ok" });
      }
      if (pathname === "/api/v3/bind-phone" || pathname === "/api/v3/bind-email") {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        bindCalls.push({
          path: pathname,
          auth: request.headers.get("authorization"),
          body,
        });
        if (options.bindStatusCode && options.bindStatusCode !== 200) {
          return Response.json({ statusCode: options.bindStatusCode, message: "bind refused" });
        }
        if (pathname === "/api/v3/bind-email" && typeof body.email === "string") {
          currentEmail = options.boundEmail ?? body.email;
        }
        if (pathname === "/api/v3/bind-phone" && typeof body.phoneNumber === "string") {
          currentPhone = options.boundPhone ?? `+86${body.phoneNumber}`;
        }
        return Response.json({ statusCode: 200, message: "ok" });
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

  return { config, token, revokedTokens, sendAuthHeaders, bindCalls };
}

function fakeDb(options: {
  identities: Record<string, string>;
  users: Record<string, { id: string; email: string | null; phone: string | null }>;
}) {
  const updatedUsers: Array<{ id: string; data: Record<string, unknown> }> = [];
  const db = {
    userIdentity: {
      findUnique: async ({
        where,
      }: {
        where: { provider_providerSubject: { provider: string; providerSubject: string } };
      }) => {
        const userId = options.identities[where.provider_providerSubject.providerSubject];
        return userId ? { userId } : null;
      },
    },
    user: {
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        updatedUsers.push({ id: where.id, data });
        const existing = options.users[where.id] ?? { id: where.id, email: null, phone: null };
        const next = {
          id: where.id,
          email: (data.email as string | undefined) ?? existing.email,
          phone: (data.phone as string | undefined) ?? existing.phone,
          emailVerified: (data.emailVerified as boolean | undefined) ?? null,
          phoneVerified: (data.phoneVerified as boolean | undefined) ?? null,
        };
        options.users[where.id] = { id: next.id, email: next.email, phone: next.phone };
        return next;
      },
    },
  } as unknown as PrismaClient;

  return { db, updatedUsers };
}

describe("MemoryContactBindStore", () => {
  test("expires staged records after TTL and consume is single-use", async () => {
    let nowMs = 1_000_000;
    const store = new MemoryContactBindStore(() => nowMs);
    const id = await store.put({
      userId: "u-1",
      authingSub: "sub-1",
      accessToken: "tok-1",
    });

    expect(await store.peek(id)).toEqual({
      userId: "u-1",
      authingSub: "sub-1",
      accessToken: "tok-1",
    });

    nowMs += CONTACT_BIND_TTL_SECONDS * 1000;
    expect(await store.peek(id)).toBeNull();

    const id2 = await store.put({
      userId: "u-1",
      authingSub: "sub-1",
      accessToken: "tok-2",
    });
    expect(await store.consume(id2)).toEqual({
      userId: "u-1",
      authingSub: "sub-1",
      accessToken: "tok-2",
    });
    expect(await store.consume(id2)).toBeNull();
  });

  test("serializes bind token as HttpOnly SameSite=Lax cookie with 10-minute TTL", () => {
    const cookie = contactBindCookie("tok-abc", true);
    expect(cookie).toContain(`${CONTACT_BIND_COOKIE}=tok-abc`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain(`Max-Age=${CONTACT_BIND_TTL_SECONDS}`);
    expect(cookie).toContain("Secure");
    expect(contactBindEndingCookie(true)).toContain("Max-Age=0");
  });
});

describe("GitHub elevation + Redis contact binding flow", () => {
  test("stages token on matching authingSub, sends bind code, binds phone, syncs User, and revokes token", async () => {
    const authing = fakeAuthingServer({ accessToken: "secret-user-tok-123", sub: "gh-sub-1" });
    const { db, updatedUsers } = fakeDb({
      identities: { "gh-sub-1": "user-1" },
      users: { "user-1": { id: "user-1", email: null, phone: null } },
    });
    const store = new MemoryContactBindStore();

    const start = startGitHubSignIn({
      config: GITHUB_CONFIG,
      sessionSecret: SESSION_SECRET,
      origin: "https://coforge.test",
      returnTo: "/settings",
      bindUserId: "user-1",
    });
    const state = new URL(start.location).searchParams.get("state")!;
    const cookieValue = start.cookie.split(";")[0]!;

    const callback = await completeGitHubSignIn({
      query: new URLSearchParams({ state, code: "gh-oauth-code" }),
      cookieHeader: cookieValue,
      config: GITHUB_CONFIG,
      authingConfig: authing.config,
      sessionSecret: SESSION_SECRET,
      secure: true,
      currentUserId: "user-1",
      contactBindStore: store,
      db,
    });
    expect(callback.status).toBe("bind_staged");
    if (callback.status !== "bind_staged") throw new Error("expected bind_staged");
    expect(callback.returnTo).toBe("/settings");
    expect(authing.revokedTokens).toEqual([]);

    const sendRes = await sendContactBindCode({
      store,
      userId: "user-1",
      bindToken: callback.bindToken,
      destination: { kind: "phone", countryCode: "+86", phone: "13800138000" },
      config: authing.config,
      rateLimits: getCodeSendRateLimits(),
    });
    expect(sendRes).toEqual({ status: "sent" });
    expect(authing.sendAuthHeaders).toEqual([`Bearer ${authing.token}`]);

    const bindRes = await bindAccountContact({
      db,
      store,
      userId: "user-1",
      bindToken: callback.bindToken,
      destination: { kind: "phone", countryCode: "+86", phone: "13800138000" },
      passCode: "123456",
      config: authing.config,
    });
    expect(bindRes).toEqual({ status: "bound", email: null, phone: "+8613800138000" });
    expect(authing.bindCalls).toEqual([
      {
        path: "/api/v3/bind-phone",
        auth: `Bearer ${authing.token}`,
        body: { passCode: "123456", phoneNumber: "13800138000", phoneCountryCode: "+86" },
      },
    ]);
    expect(updatedUsers).toEqual([
      {
        id: "user-1",
        data: { phone: "+8613800138000", phoneVerified: true },
      },
    ]);
    expect(authing.revokedTokens).toEqual([authing.token]);

    // Single-use: replaying bindToken fails without calling Authing again.
    const replayRes = await bindAccountContact({
      db,
      store,
      userId: "user-1",
      bindToken: callback.bindToken,
      destination: { kind: "phone", countryCode: "+86", phone: "13800138000" },
      passCode: "123456",
      config: authing.config,
    });
    expect(replayRes).toEqual({ status: "invalid_bind_token" });
  });

  test("rejects identity mismatch and revokes token", async () => {
    const authing = fakeAuthingServer({ accessToken: "secret-other-tok", sub: "gh-sub-other" });
    const { db } = fakeDb({
      identities: { "gh-sub-other": "user-2" },
      users: {},
    });
    const store = new MemoryContactBindStore();

    const result = await stageGitHubContactBind({
      db,
      store,
      userId: "user-1",
      code: "gh-code",
      connection: "github-conn",
      authingConfig: authing.config,
    });
    expect(result).toEqual({ status: "identity_mismatch" });
    await Bun.sleep(20);
    expect(authing.revokedTokens).toEqual([authing.token]);
  });

  test("rejects bind_failed when browser session user differs from bindUserId", async () => {
    const authing = fakeAuthingServer({});
    const { db } = fakeDb({ identities: {}, users: {} });
    const store = new MemoryContactBindStore();

    const start = startGitHubSignIn({
      config: GITHUB_CONFIG,
      sessionSecret: SESSION_SECRET,
      origin: "https://coforge.test",
      returnTo: "/settings",
      bindUserId: "user-1",
    });
    const state = new URL(start.location).searchParams.get("state")!;
    const cookieValue = start.cookie.split(";")[0]!;

    const callback = await completeGitHubSignIn({
      query: new URLSearchParams({ state, code: "gh-oauth-code" }),
      cookieHeader: `${GITHUB_SIGN_IN_COOKIE}=${cookieValue.split("=")[1]}`,
      config: GITHUB_CONFIG,
      authingConfig: authing.config,
      sessionSecret: SESSION_SECRET,
      secure: true,
      currentUserId: "user-2",
      contactBindStore: store,
      db,
    });
    expect(callback).toEqual({
      status: "bind_failed",
      error: "identity_mismatch",
      returnTo: "/settings",
    });
  });

  test("never logs accessToken or bindToken on errors", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const secretAccessToken = "authing-secret-token-never-log-9911";
      const authing = fakeAuthingServer({
        accessToken: secretAccessToken,
        sub: "gh-sub-1",
        bindStatusCode: 500,
      });
      const { db } = fakeDb({
        identities: { "gh-sub-1": "user-1" },
        users: { "user-1": { id: "user-1", email: null, phone: null } },
      });
      const store = new MemoryContactBindStore();

      const staged = await stageGitHubContactBind({
        db,
        store,
        userId: "user-1",
        code: "gh-code",
        connection: "github-conn",
        authingConfig: authing.config,
      });
      expect(staged.status).toBe("staged");
      if (staged.status !== "staged") throw new Error("expected staged");

      const bindRes = await bindAccountContact({
        db,
        store,
        userId: "user-1",
        bindToken: staged.bindToken,
        destination: { kind: "email", email: "ada@example.com" },
        passCode: "123456",
        config: authing.config,
      });
      expect(bindRes).toEqual({ status: "failed" });
      expect(authing.revokedTokens).toEqual([secretAccessToken]);

      const allLogs = [...warnSpy.mock.calls, ...errorSpy.mock.calls]
        .flat()
        .map((arg) => String(arg))
        .join("\n");
      expect(allLogs).not.toContain(secretAccessToken);
      expect(allLogs).not.toContain(staged.bindToken);
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
