import { afterAll, expect, spyOn, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { GitHubConnection } from "#src/server/integrations/github-connection.server";

if (!Bun.env.GITHUB_TEST_DATABASE_URL)
  throw new Error("GITHUB_TEST_DATABASE_URL must target disposable local PostgreSQL");
const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: Bun.env.GITHUB_TEST_DATABASE_URL }),
});
afterAll(() => db.$disconnect());

const config = {
  appId: 5261083,
  clientId: "test-client",
  clientSecret: "test-client-secret",
  callbackUrl: "https://staging.coforge.cn/api/integrations/github/callback",
  appSlug: "coforge-staging",
  encryptionKey: new Uint8Array(32).fill(7),
  webhookSecret: null,
};

/** The warnings written while `run` ran, parsed; each is one JSON line. */
async function warningsDuring(run: () => Promise<unknown>) {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await run();
    return warn.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
  } finally {
    warn.mockRestore();
  }
}

test("a code GitHub rejects is logged with GitHub's error name and nothing else", async () => {
  const user = await db.user.create({
    data: {
      displayName: `github-${crypto.randomUUID()}`,
      username: `github-${crypto.randomUUID()}`,
    },
  });
  const connection = new GitHubConnection(db, config, async (url) => {
    if (url === "https://github.com/login/oauth/access_token")
      return Response.json({
        error: "bad_verification_code",
        error_description: "private description of the failure",
      });
    throw new Error(`unexpected request to ${url}`);
  });
  try {
    const { url } = await connection.begin(user.id);
    const state = new URL(url).searchParams.get("state")!;
    const logged = await warningsDuring(async () => {
      expect(await connection.complete(user.id, state, state, "the-authorization-code")).toBe(
        false,
      );
    });
    expect(logged).toEqual([
      { event: "github.authorization_failed", stage: "exchange", reason: "bad_verification_code" },
    ]);
    const text = JSON.stringify(logged);
    for (const secret of ["the-authorization-code", "test-client-secret", "private description"])
      expect(text).not.toContain(secret);
  } finally {
    await db.user.delete({ where: { id: user.id } });
  }
});

test("a browser whose state cookie does not match is logged as a state failure", async () => {
  const user = await db.user.create({
    data: {
      displayName: `github-${crypto.randomUUID()}`,
      username: `github-${crypto.randomUUID()}`,
    },
  });
  const connection = new GitHubConnection(db, config, async (url) => {
    throw new Error(`unexpected request to ${url}`);
  });
  try {
    const { url } = await connection.begin(user.id);
    const state = new URL(url).searchParams.get("state")!;
    const logged = await warningsDuring(async () => {
      expect(await connection.complete(user.id, "", state, "code")).toBe(false);
    });
    expect(logged).toEqual([
      { event: "github.authorization_failed", stage: "state", reason: "browser_state_missing" },
    ]);
  } finally {
    await db.user.delete({ where: { id: user.id } });
  }
});

test("a GitHub user that cannot be read after the exchange is logged as a user failure", async () => {
  const user = await db.user.create({
    data: {
      displayName: `github-${crypto.randomUUID()}`,
      username: `github-${crypto.randomUUID()}`,
    },
  });
  const connection = new GitHubConnection(db, config, async (url) => {
    if (url === "https://github.com/login/oauth/access_token")
      return Response.json({
        access_token: "ghu_private_token",
        refresh_token: "ghr_private_token",
        expires_in: 28800,
        refresh_token_expires_in: 15897600,
        token_type: "bearer",
      });
    return Response.json({ message: "Bad credentials" }, { status: 401 });
  });
  try {
    const { url } = await connection.begin(user.id);
    const state = new URL(url).searchParams.get("state")!;
    const logged = await warningsDuring(async () => {
      expect(await connection.complete(user.id, state, state, "code")).toBe(false);
    });
    expect(logged).toEqual([
      { event: "github.authorization_failed", stage: "user", reason: "unauthorized" },
    ]);
    expect(JSON.stringify(logged)).not.toContain("private_token");
  } finally {
    await db.user.delete({ where: { id: user.id } });
  }
});

/**
 * A user whose GitHub connection completed at `now()` and whose token has since expired, so the next
 * credential read refreshes it through `refresh` (GitHub's answer to the refresh exchange).
 */
async function expiredConnection(refresh: () => Response | Promise<Response>) {
  const user = await db.user.create({
    data: {
      displayName: `github-${crypto.randomUUID()}`,
      username: `github-${crypto.randomUUID()}`,
    },
  });
  let now = Date.now();
  let connected = false;
  const connection = new GitHubConnection(
    db,
    config,
    async (url) => {
      if (url === "https://github.com/login/oauth/access_token") {
        if (connected) return refresh();
        return Response.json({
          access_token: "ghu_private_token",
          refresh_token: "ghr_private_token",
          expires_in: 28800,
          refresh_token_expires_in: 15897600,
          token_type: "bearer",
        });
      }
      if (url.startsWith("https://api.github.com/user/installations"))
        return Response.json({ total_count: 0, installations: [] });
      return Response.json({ id: 73, login: "credential-owner" });
    },
    () => now,
  );
  const { url } = await connection.begin(user.id);
  const state = new URL(url).searchParams.get("state")!;
  expect(await connection.complete(user.id, state, state, "code")).toBe(true);
  connected = true;
  now += 28800_000;
  return { user, connection };
}

/** The code `credential()` threw, as the route reads it, and the warnings it logged meanwhile. */
async function credentialFailure(connection: GitHubConnection, userId: string) {
  let failure: unknown;
  const logged = await warningsDuring(async () => {
    failure = await connection.credential(userId).catch((thrown: unknown) => thrown);
  });
  return { code: (failure as { code?: string }).code, logged };
}

test("an Agent credential for a person with no GitHub connection asks them to connect, and says so in the log", async () => {
  const user = await db.user.create({
    data: {
      displayName: `github-${crypto.randomUUID()}`,
      username: `github-${crypto.randomUUID()}`,
    },
  });
  const connection = new GitHubConnection(db, config, async (url) => {
    throw new Error(`unexpected request to ${url}`);
  });
  try {
    const { code, logged } = await credentialFailure(connection, user.id);
    expect(code).toBe("ACCESS_DENIED");
    expect(logged).toEqual([
      {
        event: "github.credential_failed",
        userId: user.id,
        outcome: "reconnect",
        reason: "disconnected",
      },
    ]);
  } finally {
    await db.user.delete({ where: { id: user.id } });
  }
});

test("an Agent credential whose refresh GitHub revoked asks the person to reconnect", async () => {
  const { user, connection } = await expiredConnection(() =>
    Response.json({ error: "bad_refresh_token", error_description: "private description" }),
  );
  try {
    const { code, logged } = await credentialFailure(connection, user.id);
    expect(code).toBe("ACCESS_DENIED");
    expect(logged).toEqual([
      {
        event: "github.credential_failed",
        userId: user.id,
        outcome: "reconnect",
        reason: "reauthorize",
      },
    ]);
  } finally {
    await db.user.delete({ where: { id: user.id } });
  }
});

test("an Agent credential GitHub cannot refresh right now is temporarily unavailable, with GitHub's reason in the log", async () => {
  for (const [answer, reason] of [
    [() => Response.json({ error: "server_error", error_description: "private" }), "server_error"],
    [() => new Response("upstream down", { status: 502 }), "http_502"],
    // A 403/404 from the token endpoint is not a revoked authorization (that is `bad_refresh_token`),
    // so it clears nothing and asks no one to reconnect.
    [() => new Response("private not found", { status: 404 }), "access_denied"],
    [
      () => {
        throw new TypeError("connection refused");
      },
      "network",
    ],
  ] as const) {
    const { user, connection } = await expiredConnection(answer);
    try {
      const { code, logged } = await credentialFailure(connection, user.id);
      expect(code).toBe("TEMPORARILY_UNAVAILABLE");
      expect(logged).toEqual([
        { event: "github.credential_failed", userId: user.id, outcome: "unavailable", reason },
      ]);
      expect(JSON.stringify(logged)).not.toContain("private");
    } finally {
      await db.user.delete({ where: { id: user.id } });
    }
  }
});

test("an Agent credential whose connection lock cannot be taken is temporarily unavailable, and says why in the log", async () => {
  const lockTimeout = Object.assign(
    new Error("Transaction API error: Unable to start a transaction in the given time."),
    { code: "P2028" },
  );
  for (const [thrown, reason] of [
    [lockTimeout, "lock_timeout"],
    [new Error("the database went away"), "error"],
  ] as const) {
    // The lock is the transaction `credential()` opens before anything else.
    const connection = new GitHubConnection(
      {
        $transaction: async () => {
          throw thrown;
        },
      } as never,
      config,
      async (url) => {
        throw new Error(`unexpected request to ${url}`);
      },
    );
    const { code, logged } = await credentialFailure(connection, "user-without-lock");
    expect(code).toBe("TEMPORARILY_UNAVAILABLE");
    expect(logged).toEqual([
      {
        event: "github.credential_failed",
        userId: "user-without-lock",
        outcome: "unavailable",
        reason,
      },
    ]);
  }
});
