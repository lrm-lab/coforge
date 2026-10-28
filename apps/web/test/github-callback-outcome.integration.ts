import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import {
  GITHUB_STATE_COOKIE,
  githubCallbackHandler,
} from "#src/server/integrations/github-http.server";
import { configuredGitHub } from "#src/server/integrations/github-config.server";
import { inFreshTestProcess } from "./helpers/fresh-test-process";
import { fakeGitHub } from "./helpers/fake-github";

if (!Bun.env.GITHUB_TEST_DATABASE_URL)
  throw new Error("GITHUB_TEST_DATABASE_URL must target disposable local PostgreSQL");
const databaseUrl = Bun.env.GITHUB_TEST_DATABASE_URL;
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });

// The handler builds its connection from the environment and the server's database client, so the
// test configures both the way a deployment does, and restores them afterwards. That client is cached
// for the life of the process and the module offers no reset, so the case runs in a process of its own.
const environment: Record<string, string> = {
  DATABASE_URL: databaseUrl,
  NODE_ENV: "development",
  COFORGE_DEV_SKIP_AUTH: "1",
  COFORGE_GITHUB_CLIENT_ID: "test-client",
  COFORGE_GITHUB_CLIENT_SECRET: "test-client-secret",
  COFORGE_GITHUB_CREDENTIAL_ENCRYPTION_KEY: "07".repeat(32),
  COFORGE_GITHUB_APP_ID: "5261083",
  COFORGE_GITHUB_APP_SLUG: "coforge-staging",
  COFORGE_GITHUB_CALLBACK_URL: "https://staging.coforge.cn/api/integrations/github/callback",
};
const previous = Object.fromEntries(Object.keys(environment).map((name) => [name, Bun.env[name]]));
let createdDevUser = false;

beforeAll(async () => {
  Object.assign(process.env, environment);
  // The signed-in person is the dev user (`COFORGE_DEV_SKIP_AUTH`). A seeded database already has it.
  if (!(await db.user.findUnique({ where: { id: DEV_BROWSER_USER.id } }))) {
    await db.user.create({
      data: {
        id: DEV_BROWSER_USER.id,
        displayName: DEV_BROWSER_USER.name,
        username: DEV_BROWSER_USER.username,
      },
    });
    createdDevUser = true;
  }
});

afterAll(async () => {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (createdDevUser) await db.user.delete({ where: { id: DEV_BROWSER_USER.id } });
  await db.$disconnect();
});

test("the callback sends a person whose GitHub account is connected to someone else to Settings, naming why", () =>
  inFreshTestProcess(
    import.meta.path,
    "the callback sends a person whose GitHub account is connected to someone else to Settings, naming why",
    async () => {
      const owner = await db.user.create({
        data: {
          displayName: `github-${crypto.randomUUID()}`,
          username: `github-${crypto.randomUUID()}`,
        },
      });
      const githubUserId = Math.floor(Math.random() * 1_000_000_000) + 1;
      const github = fakeGitHub(() => githubUserId);
      const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(((
        url: string | URL | Request,
        init?: RequestInit,
      ) => github.http(String(url), init ?? {})) as typeof fetch);
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        const configured = (await configuredGitHub())!;
        const begun = await configured.connection.begin(owner.id);
        expect(
          await configured.connection.complete(owner.id, begun.state, begun.state, "owner"),
        ).toBe(true);

        const { state } = await configured.connection.begin(DEV_BROWSER_USER.id);
        const response = await githubCallbackHandler({
          request: new Request(
            `https://coforge.test/api/integrations/github/callback?code=dev&state=${state}`,
            { headers: { cookie: `${GITHUB_STATE_COOKIE}=${state}; coforge_workspace=acme` } },
          ),
        });
        expect(response.status).toBe(303);
        expect(response.headers.get("location")).toBe(
          "/w/acme/settings?section=integrations&github=account_taken",
        );
        expect(
          await db.gitHubConnection.findUnique({ where: { userId: DEV_BROWSER_USER.id } }),
        ).toBe(null);
        // The refused person's token is revoked in the background; it must finish before fetch is restored.
        await github.revocations(1);
      } finally {
        fetchSpy.mockRestore();
        warn.mockRestore();
        await db.gitHubAuthorization.deleteMany({ where: { userId: DEV_BROWSER_USER.id } });
        await db.user.delete({ where: { id: owner.id } });
      }
    },
  ));
