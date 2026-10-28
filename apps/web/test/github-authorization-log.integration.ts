import { afterAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { GitHubConnection } from "#src/server/integrations/github-connection.server";
import { fakeGitHub } from "./helpers/fake-github";
import { githubTestConfig as config, warningsDuring } from "./helpers/github-test-config";

if (!Bun.env.GITHUB_TEST_DATABASE_URL)
  throw new Error("GITHUB_TEST_DATABASE_URL must target disposable local PostgreSQL");
const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: Bun.env.GITHUB_TEST_DATABASE_URL }),
});
afterAll(() => db.$disconnect());

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
  const connection = new GitHubConnection(db, config, async (url, init) => {
    if (url === "https://github.com/login/oauth/access_token")
      return Response.json({
        access_token: "ghu_private_token",
        refresh_token: "ghr_private_token",
        expires_in: 28800,
        refresh_token_expires_in: 15897600,
        token_type: "bearer",
      });
    if (init.method === "DELETE") return new Response(null, { status: 204 });
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

test("a GitHub account another person has connected is refused as taken, and says so in the log", async () => {
  const [owner, other] = await newUsers(2);
  let githubUserId = Math.floor(Math.random() * 1_000_000_000) + 1;
  const github = fakeGitHub(() => githubUserId);
  const connection = new GitHubConnection(db, config, github.http);
  try {
    expect(await connect(connection, owner!.id)).toBe(true);
    const logged = await warningsDuring(async () => {
      expect(await connect(connection, other!.id)).toBe("account_taken");
    });
    expect(logged).toEqual([
      { event: "github.authorization_failed", stage: "owner", reason: "github_account_taken" },
    ]);
    expect(await db.gitHubConnection.findUnique({ where: { userId: other!.id } })).toBeNull();

    // Reauthorizing a connection must come back as the same GitHub account. Another person's
    // account is the wrong one first: the fix is to pick the connected account, not to free it.
    githubUserId += 1;
    expect(await connect(connection, other!.id)).toBe(true);
    githubUserId -= 1;
    const { url } = await connection.begin(other!.id, "reauthorize");
    const state = new URL(url).searchParams.get("state")!;
    expect(await connection.complete(other!.id, state, state, "code")).toBe("wrong_account");
  } finally {
    await db.user.deleteMany({ where: { id: { in: [owner!.id, other!.id] } } });
  }
});

async function newUsers(count: number) {
  return Promise.all(
    Array.from({ length: count }, () =>
      db.user.create({
        data: {
          displayName: `github-${crypto.randomUUID()}`,
          username: `github-${crypto.randomUUID()}`,
        },
      }),
    ),
  );
}

async function connect(connection: GitHubConnection, userId: string, code = "code") {
  const { url } = await connection.begin(userId);
  const state = new URL(url).searchParams.get("state")!;
  return connection.complete(userId, state, state, code);
}

const revokeUrl = "https://api.github.com/applications/test-client/token";
const revokeAuthorization = `Basic ${btoa("test-client:test-client-secret")}`;

test("two people finishing OAuth for one GitHub account at once: one connects, the other is told it is taken", async () => {
  const [first, second] = await newUsers(2);
  const githubUserId = Math.floor(Math.random() * 1_000_000_000) + 1;
  // Neither /user answer is sent until both requests have arrived, so both transactions read
  // "no connection" before either one commits.
  let arrived = 0;
  let release!: () => void;
  const both = new Promise<void>((resolve) => (release = resolve));
  // Fails fast, instead of hanging, if only one /user request ever arrives.
  const bothOrTimeout = Promise.race([
    both,
    Bun.sleep(5_000).then(() => {
      throw new Error(`only ${arrived} of 2 /user requests arrived`);
    }),
  ]);
  const github = fakeGitHub(async () => {
    if (++arrived === 2) release();
    await bothOrTimeout;
    return githubUserId;
  });
  const connection = new GitHubConnection(db, config, github.http);
  try {
    const logged = await warningsDuring(async () => {
      const results = await Promise.all([
        connect(connection, first!.id, "first"),
        connect(connection, second!.id, "second"),
      ]);
      expect([...results].sort()).toEqual(["account_taken", true]);
      const [winner, loser] = results[0] === true ? [first!, second!] : [second!, first!];
      expect(await db.gitHubConnection.findUnique({ where: { userId: winner.id } })).not.toBeNull();
      expect(await db.gitHubConnection.findUnique({ where: { userId: loser.id } })).toBeNull();
      // The refused person's attempt is consumed, not rolled back with the refusal.
      expect(await db.gitHubAuthorization.findUnique({ where: { userId: loser.id } })).toBeNull();
      // The refused person's token is revoked; the connected person's is kept.
      await github.revocations(1);
      expect(github.revoked).toEqual([
        {
          url: revokeUrl,
          authorization: revokeAuthorization,
          body: { access_token: `ghu_${loser === first ? "first" : "second"}` },
        },
      ]);
    });
    expect(logged).toEqual([
      { event: "github.authorization_failed", stage: "owner", reason: "github_account_taken" },
    ]);
  } finally {
    await db.user.deleteMany({ where: { id: { in: [first!.id, second!.id] } } });
  }
});

test("a connection that is refused revokes the token GitHub issued, and a connection that is kept does not", async () => {
  const [owner, other] = await newUsers(2);
  const github = fakeGitHub((token) => (token === "ghu_other-again" ? 91 : 90));
  const connection = new GitHubConnection(db, config, github.http);
  try {
    expect(await connect(connection, owner!.id, "owner")).toBe(true);
    await Bun.sleep(50);
    expect(github.revoked).toEqual([]);

    expect(await connect(connection, other!.id, "other")).toBe("account_taken");
    await github.revocations(1);
    expect(github.revoked).toEqual([
      { url: revokeUrl, authorization: revokeAuthorization, body: { access_token: "ghu_other" } },
    ]);

    // Reauthorizing as a different GitHub account than the connected one is the wrong account.
    expect(await connect(connection, other!.id, "other-again")).toBe(true);
    github.revoked.length = 0;
    const { url } = await connection.begin(other!.id, "reauthorize");
    const state = new URL(url).searchParams.get("state")!;
    expect(await connection.complete(other!.id, state, state, "other")).toBe("wrong_account");
    await github.revocations(1);
    expect(github.revoked).toEqual([
      { url: revokeUrl, authorization: revokeAuthorization, body: { access_token: "ghu_other" } },
    ]);
  } finally {
    await db.user.deleteMany({ where: { id: { in: [owner!.id, other!.id] } } });
  }
});

test("a revoke GitHub refuses changes nothing the person sees, and the log holds a reason only", async () => {
  const [owner, other] = await newUsers(2);
  const github = fakeGitHub(
    () => 92,
    () => Response.json({ message: "private revoke failure" }, { status: 422 }),
  );
  const connection = new GitHubConnection(db, config, github.http);
  try {
    expect(await connect(connection, owner!.id, "owner")).toBe(true);
    const logged = await warningsDuring(async () => {
      expect(await connect(connection, other!.id, "other")).toBe("account_taken");
      await github.revocations(1);
    });
    expect(logged).toEqual([
      { event: "github.authorization_failed", stage: "owner", reason: "github_account_taken" },
      { event: "github.token_revoke_failed", reason: "http_422" },
    ]);
    const text = JSON.stringify(logged);
    for (const secret of ["ghu_other", "test-client-secret", "private revoke failure"])
      expect(text).not.toContain(secret);
  } finally {
    await db.user.deleteMany({ where: { id: { in: [owner!.id, other!.id] } } });
  }
});

test("a token GitHub issued is revoked when its /user read fails, without the person waiting for it", async () => {
  const [user] = await newUsers(1);
  let revokeDone = false;
  const github = fakeGitHub(
    () => {
      throw new Error("GitHub is down");
    },
    () => {
      revokeDone = true;
      return new Response(null, { status: 204 });
    },
  );
  const connection = new GitHubConnection(db, config, async (url, init) => {
    // A slow revoke must not hold the callback.
    if (init.method === "DELETE") await Bun.sleep(300);
    return github.http(url, init);
  });
  try {
    const logged = await warningsDuring(async () => {
      expect(await connect(connection, user!.id, "down")).toBe(false);
      expect(revokeDone).toBe(false);
      await github.revocations(1);
    });
    expect(logged).toEqual([
      { event: "github.authorization_failed", stage: "user", reason: "network" },
    ]);
    expect(github.revoked).toEqual([
      { url: revokeUrl, authorization: revokeAuthorization, body: { access_token: "ghu_down" } },
    ]);
  } finally {
    await db.user.delete({ where: { id: user!.id } });
  }
});

test("a token GitHub issued is revoked when storing the connection throws, and the error still surfaces", async () => {
  const [user] = await newUsers(1);
  const github = fakeGitHub(() => 93);
  // The same client, except the connection write fails.
  const failing = new Proxy(db, {
    get(target, property, receiver) {
      if (property !== "$transaction") return Reflect.get(target, property, receiver);
      return (action: (tx: never) => unknown, options: unknown) =>
        (target.$transaction as (...args: unknown[]) => unknown)(
          (tx: Record<string, unknown>) =>
            action(
              new Proxy(tx, {
                get(inner, name, innerReceiver) {
                  if (name !== "gitHubConnection") return Reflect.get(inner, name, innerReceiver);
                  return new Proxy(inner.gitHubConnection as object, {
                    get(delegate, method, delegateReceiver) {
                      if (method !== "upsert")
                        return Reflect.get(delegate, method, delegateReceiver);
                      return () => Promise.reject(new Error("the database went away"));
                    },
                  });
                },
              }) as never,
            ),
          options,
        );
    },
  });
  const connection = new GitHubConnection(failing, config, github.http);
  try {
    await expect(connect(connection, user!.id, "stored")).rejects.toThrow("the database went away");
    await github.revocations(1);
    expect(github.revoked).toEqual([
      { url: revokeUrl, authorization: revokeAuthorization, body: { access_token: "ghu_stored" } },
    ]);
  } finally {
    await db.user.delete({ where: { id: user!.id } });
  }
});

test("a disconnect is not held up by a slow code exchange, and cancels the connect, whose token is revoked", async () => {
  const [user] = await newUsers(1);
  const github = fakeGitHub(() => 94);
  let exchangeStarted!: () => void;
  const started = new Promise<void>((resolve) => (exchangeStarted = resolve));
  let finishExchange!: () => void;
  const finished = new Promise<void>((resolve) => (finishExchange = resolve));
  const connection = new GitHubConnection(db, config, async (url, init) => {
    if (url === "https://github.com/login/oauth/access_token") {
      exchangeStarted();
      await finished;
    }
    return github.http(url, init);
  });
  try {
    const connecting = connect(connection, user!.id, "slow");
    await started;
    const disconnected = await Promise.race([
      connection.disconnect(user!.id).then(() => true),
      Bun.sleep(2_000).then(() => false),
    ]);
    finishExchange();
    expect(disconnected).toBe(true);
    await warningsDuring(async () => expect(await connecting).toBe(false));
    await github.revocations(1);
    expect(github.revoked).toEqual([
      { url: revokeUrl, authorization: revokeAuthorization, body: { access_token: "ghu_slow" } },
    ]);
    expect(await db.gitHubConnection.findUnique({ where: { userId: user!.id } })).toBeNull();
  } finally {
    finishExchange();
    await db.user.delete({ where: { id: user!.id } });
  }
});
