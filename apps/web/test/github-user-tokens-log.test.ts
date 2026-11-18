import { afterEach, expect, spyOn, test } from "bun:test";
import { AppError } from "#src/lib/app-error";
import {
  GitHubOAuthRejected,
  GitHubUnauthorized,
} from "#src/server/integrations/github-api.server";
import { GitHubUserTokens } from "#src/server/integrations/github-user-tokens.server";

const NOW = Date.parse("2026-11-18T16:00:00Z");
const row = (overrides: Record<string, unknown> = {}) => ({
  userId: "u1",
  login: "frank",
  githubUserId: "9",
  clientId: "client",
  credentials: "sealed",
  expiresAt: new Date(NOW - 1000),
  refreshExpiresAt: new Date(NOW + 86_400_000),
  updatedAt: new Date(NOW - 5000),
  ...overrides,
});

function tokens(
  stored: ReturnType<typeof row>,
  exchange: () => Promise<unknown>,
  clock: { now: number } = { now: NOW },
  counts = { transactions: 0 },
) {
  let queue: Promise<unknown> = Promise.resolve();
  const state = { row: stored };
  const db = {
    $transaction: (fn: (tx: unknown) => unknown) => {
      counts.transactions++;
      const run = queue.then(() =>
        fn({
          $queryRaw: async () => [],
          gitHubConnection: {
            findUnique: async () => state.row,
            update: async ({ data }: { data: Record<string, unknown> }) => {
              state.row = { ...state.row, ...data } as typeof state.row;
              return state.row;
            },
          },
        }),
      );
      queue = run.catch(() => {});
      return run;
    },
  };
  const sealed = {
    open: async () => JSON.stringify({ access_token: "a", refresh_token: "r" }),
    seal: async () => "sealed2",
  };
  return new GitHubUserTokens(
    db as never,
    { clientId: "client" },
    { exchange } as never,
    sealed as never,
    () => clock.now,
  );
}

const events = (warn: ReturnType<typeof spyOn>) =>
  warn.mock.calls.map(([line]: [string]) => JSON.parse(line));
afterEach(() => spyOn(console, "warn").mockRestore());

test("a refused refresh token logs where and why the credential was cleared", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const result = await tokens(row(), async () => {
    throw new GitHubUnauthorized();
  }).withToken("u1", async () => 1);
  expect(result).toMatchObject({ ok: false, status: "reauthorize" });
  expect(events(warn)).toEqual([
    {
      event: "github.credentials_cleared",
      userId: "u1",
      site: "refresh",
      reason: "bad_refresh_token",
      expiresAt: new Date(NOW - 1000).toISOString(),
      refreshExpiresAt: new Date(NOW + 86_400_000).toISOString(),
      updatedAt: new Date(NOW - 5000).toISOString(),
    },
  ]);
});

test("expired refresh token and a client mismatch are named apart", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  await tokens(row({ refreshExpiresAt: new Date(NOW - 1) }), async () => ({})).withToken(
    "u1",
    async () => 1,
  );
  await tokens(row({ clientId: "other" }), async () => ({})).withToken("u1", async () => 1);
  expect(events(warn).map((e: { reason: string }) => e.reason)).toEqual([
    "refresh_token_expired",
    "client_mismatch",
  ]);
});

test("a refresh that times out logs refresh_uncertain and clears nothing", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  await expect(
    tokens(row(), async () => {
      throw new AppError("TEMPORARILY_UNAVAILABLE");
    }).withToken("u1", async () => 1),
  ).rejects.toBeInstanceOf(AppError);
  const [event, ...rest] = events(warn);
  expect(rest).toEqual([]);
  expect(event).toMatchObject({
    event: "github.refresh_uncertain",
    userId: "u1",
    stage: "exchange",
    at: new Date(NOW).toISOString(),
  });
});

test("a refresh GitHub refused outright is not uncertain", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  await tokens(row(), async () => {
    throw new GitHubOAuthRejected("incorrect_client_credentials");
  })
    .withToken("u1", async () => 1)
    .catch(() => {});
  expect(events(warn)).toEqual([]);
});

test("a 401 on the call clears and logs the call site", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const result = await tokens(
    row({ expiresAt: new Date(NOW + 3_600_000) }),
    async () => ({}),
  ).withToken("u1", async () => {
    throw new GitHubUnauthorized();
  });
  expect(result).toMatchObject({ ok: false, status: "reauthorize" });
  expect(events(warn)).toMatchObject([{ event: "github.credentials_cleared", site: "call_401" }]);
});

test("a transaction that does not commit logs no cleared credential", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const t = tokens(row(), async () => {
    throw new GitHubUnauthorized();
  });
  const db = (t as unknown as { db: { $transaction: (fn: never) => Promise<unknown> } }).db;
  const run = db.$transaction.bind(db);
  db.$transaction = async (fn: never) => {
    await run(fn);
    throw new Error("commit failed");
  };
  await t.withToken("u1", async () => 1).catch(() => {});
  expect(events(warn)).toEqual([]);
});
