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

/** The warnings `complete` wrote while `run` ran, parsed; each is one JSON line. */
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
  const user = await db.user.create({ data: { username: `github-${crypto.randomUUID()}` } });
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
  const user = await db.user.create({ data: { username: `github-${crypto.randomUUID()}` } });
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
  const user = await db.user.create({ data: { username: `github-${crypto.randomUUID()}` } });
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
