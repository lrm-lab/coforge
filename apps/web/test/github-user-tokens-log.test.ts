import { afterEach, expect, spyOn, test } from "bun:test";
import { AppError } from "#src/lib/app-error";
import {
  GitHubOAuthRejected,
  GitHubUnauthorized,
} from "#src/server/integrations/github-api.server";
import {
  GitHubUserTokens,
  REFRESH_COOLDOWN_MS,
} from "#src/server/integrations/github-user-tokens.server";

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
  failure?: "write" | "commit",
) {
  let queue: Promise<unknown> = Promise.resolve();
  const state = { row: stored };
  const db = {
    $transaction: (fn: (tx: unknown) => unknown) => {
      counts.transactions++;
      const run = queue.then(async () => {
        let next = state.row;
        const result = await fn({
          $queryRaw: async () => [],
          gitHubConnection: {
            findUnique: async () => state.row,
            update: async ({ data }: { data: Record<string, unknown> }) => {
              if (failure === "write") throw new Error("write failed");
              next = { ...next, ...data };
              return next;
            },
          },
        });
        if (failure === "commit") throw new Error("commit failed");
        state.row = next;
        return result;
      });
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

const timeout = async () => {
  throw new AppError("TEMPORARILY_UNAVAILABLE");
};
const fresh = async () => ({
  access_token: "a2",
  refresh_token: "r2",
  expires_in: 28800,
  refresh_token_expires_in: 15811200,
});

test("after a refresh gets no answer, requests in the cooldown neither exchange nor take the lock", async () => {
  spyOn(console, "warn").mockImplementation(() => {});
  const counts = { transactions: 0 };
  let exchanges = 0;
  const t = tokens(
    row(),
    async () => {
      exchanges++;
      return timeout();
    },
    { now: NOW },
    counts,
  );
  await t.withToken("u1", async () => 1).catch(() => {});
  expect([exchanges, counts.transactions]).toEqual([1, 1]);
  const refused = await t.withToken("u1", async () => 1).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(AppError);
  expect([exchanges, counts.transactions]).toEqual([1, 1]);
});

test("the first request after the cooldown refreshes again", async () => {
  spyOn(console, "warn").mockImplementation(() => {});
  const clock = { now: NOW };
  let exchanges = 0;
  const t = tokens(
    row(),
    async () => {
      exchanges++;
      return exchanges === 1 ? timeout() : fresh();
    },
    clock,
  );
  await t.withToken("u1", async () => 1).catch(() => {});
  clock.now = NOW + REFRESH_COOLDOWN_MS - 1;
  await t.withToken("u1", async () => 1).catch(() => {});
  expect(exchanges).toBe(1);
  clock.now = NOW + REFRESH_COOLDOWN_MS;
  const result = await t.withToken("u1", async (token) => token);
  expect(exchanges).toBe(2);
  expect(result).toMatchObject({ ok: true, data: "a2" });
});

test("connecting or disconnecting clears the cooldown", async () => {
  spyOn(console, "warn").mockImplementation(() => {});
  let exchanges = 0;
  const t = tokens(row(), async () => {
    exchanges++;
    return timeout();
  });
  await t.withToken("u1", async () => 1).catch(() => {});
  t.forgetRefreshCooldown("u1");
  await t.withToken("u1", async () => 1).catch(() => {});
  expect(exchanges).toBe(2);
  await t.storedTokens("u1", (await fresh()) as never);
  await t.withToken("u1", async () => 1).catch(() => {});
  expect(exchanges).toBe(3);
});

test("a request already waiting on the lock does not send the refresh token again", async () => {
  spyOn(console, "warn").mockImplementation(() => {});
  let exchanges = 0;
  const t = tokens(row(), async () => {
    exchanges++;
    await Promise.resolve();
    return timeout();
  });
  const results = await Promise.all([
    t.withToken("u1", async () => 1).catch((error: unknown) => error),
    t.withToken("u1", async () => 1).catch((error: unknown) => error),
    t.withToken("u1", async () => 1).catch((error: unknown) => error),
  ]);
  expect(exchanges).toBe(1);
  expect(results.every((result) => result instanceof AppError)).toBe(true);
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

test("a committed refresh logs only the event, even if the downstream call fails, and reuse adds nothing", async () => {
  const info = spyOn(console, "info").mockImplementation(() => {});
  try {
    let exchanges = 0;
    const t = tokens(row(), () => {
      exchanges++;
      return fresh();
    });
    const expected = [{ event: "github.refresh_committed" }];
    const downstreamError = new AppError("TEMPORARILY_UNAVAILABLE");
    let observedByAction: ReturnType<typeof events> | undefined;
    await expect(
      t.withToken("u1", async () => {
        observedByAction = events(info);
        throw downstreamError;
      }),
    ).rejects.toBe(downstreamError);
    expect(observedByAction).toEqual(expected);
    expect(await t.withToken("u1", async () => 1)).toEqual({ ok: true, data: 1 });
    expect(exchanges).toBe(1);
    expect(events(info)).toEqual(expected);
  } finally {
    info.mockRestore();
  }
});

test.each(["write", "commit"] as const)(
  "a refresh that fails at %s logs no committed event",
  async (failure) => {
    const info = spyOn(console, "info").mockImplementation(() => {});
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const t = tokens(row(), fresh, { now: NOW }, { transactions: 0 }, failure);
      const expectedError = failure === "write" ? "TEMPORARILY_UNAVAILABLE" : "commit failed";
      let called = false;
      await expect(
        t.withToken("u1", async () => {
          called = true;
          return 1;
        }),
      ).rejects.toThrow(expectedError);
      expect(events(info)).toEqual([]);
      expect(called).toBe(false);
    } finally {
      warn.mockRestore();
      info.mockRestore();
    }
  },
);

test("refresh token exchange runs outside any open database transaction and uses a short lock timeout", async () => {
  const info = spyOn(console, "info").mockImplementation(() => {});
  try {
    let activeTx = 0;
    let activeTxDuringExchange = -1;
    const timeouts: number[] = [];
    const state = { row: row() as ReturnType<typeof row> | null };
    const db = {
      $transaction: async (
        fn: (tx: unknown) => Promise<unknown>,
        options?: { timeout?: number },
      ) => {
        if (options?.timeout !== undefined) timeouts.push(options.timeout);
        activeTx += 1;
        try {
          return await fn({
            $queryRaw: async () => [],
            gitHubConnection: {
              findUnique: async () => state.row,
              update: async ({ data }: { data: Record<string, unknown> }) => {
                state.row = state.row ? { ...state.row, ...data, updatedAt: new Date(NOW) } : null;
                return state.row;
              },
            },
          });
        } finally {
          activeTx -= 1;
        }
      },
    };
    const sealed = {
      open: async () => JSON.stringify({ access_token: "a", refresh_token: "r" }),
      seal: async () => "sealed2",
    };
    const revoked: string[] = [];
    const t = new GitHubUserTokens(
      db as never,
      { clientId: "client" },
      {
        exchange: async () => {
          activeTxDuringExchange = activeTx;
          return fresh();
        },
        revoke: async (token: string) => {
          revoked.push(token);
        },
      } as never,
      sealed as never,
      () => NOW,
    );

    const res = await t.withToken("u1", async (token) => token);
    expect(res).toEqual({ ok: true, data: "a2" });
    expect(activeTxDuringExchange).toBe(0);
    expect(revoked).toEqual([]);
    expect(timeouts.every((ms) => ms <= 5_000)).toBe(true);
    expect(events(info)).toEqual([{ event: "github.refresh_committed" }]);
  } finally {
    info.mockRestore();
  }
});

test("a disconnect during external refresh exchange revokes the unstored token and does not recreate credentials", async () => {
  let state: ReturnType<typeof row> | null = row();
  let updates = 0;
  const revoked: string[] = [];
  const db = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        $queryRaw: async () => [],
        gitHubConnection: {
          findUnique: async () => state,
          update: async () => {
            updates += 1;
            return state;
          },
        },
      }),
  };
  const sealed = {
    open: async () => JSON.stringify({ access_token: "a", refresh_token: "r" }),
    seal: async () => "sealed2",
  };
  const t = new GitHubUserTokens(
    db as never,
    { clientId: "client" },
    {
      exchange: async () => {
        state = null;
        return fresh();
      },
      revoke: async (token: string) => {
        revoked.push(token);
      },
    } as never,
    sealed as never,
    () => NOW,
  );

  const res = await t.withToken("u1", async (token) => token);
  expect(res).toEqual({ ok: false, status: "disconnected", login: null });
  expect(updates).toBe(0);
  expect(revoked).toEqual(["a2"]);
});

test("separate GitHubUserTokens instances sharing a db coalesce concurrent refreshes", async () => {
  const info = spyOn(console, "info").mockImplementation(() => {});
  try {
    let queue: Promise<unknown> = Promise.resolve();
    const state = { row: row() };
    const db = {
      $transaction: (fn: (tx: unknown) => Promise<unknown>) => {
        const run = queue.then(() =>
          fn({
            $queryRaw: async () => [],
            gitHubConnection: {
              findUnique: async () => state.row,
              update: async ({ data }: { data: Record<string, unknown> }) => {
                state.row = { ...state.row, ...data, updatedAt: new Date(NOW) };
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
      open: async (_u: string, _p: string, value: string) =>
        JSON.stringify(
          value === "sealed2"
            ? { access_token: "a2", refresh_token: "r2" }
            : { access_token: "a", refresh_token: "r" },
        ),
      seal: async () => "sealed2",
    };
    let exchanges = 0;
    const github = {
      exchange: async () => {
        exchanges += 1;
        await Promise.resolve();
        return fresh();
      },
    };
    const first = new GitHubUserTokens(
      db as never,
      { clientId: "client" },
      github as never,
      sealed as never,
      () => NOW,
    );
    const second = new GitHubUserTokens(
      db as never,
      { clientId: "client" },
      github as never,
      sealed as never,
      () => NOW,
    );

    const results = await Promise.all([
      first.withToken("u1", async (token) => token),
      second.withToken("u1", async (token) => token),
    ]);
    expect(exchanges).toBe(1);
    expect(results).toEqual([
      { ok: true, data: "a2" },
      { ok: true, data: "a2" },
    ]);
    expect(events(info)).toEqual([{ event: "github.refresh_committed" }]);
  } finally {
    info.mockRestore();
  }
});

test("Phase-1 commit failure releases inflight refresh state and CAS mismatch on external rotation reuses fresh token", async () => {
  let state = row();
  let failCommitOnce = true;
  const revoked: string[] = [];
  const db = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const result = await fn({
        $queryRaw: async () => [],
        gitHubConnection: {
          findUnique: async () => state,
          update: async ({ data }: { data: Record<string, unknown> }) => {
            state = { ...state, ...data, updatedAt: new Date(NOW + 100) };
            return state;
          },
        },
      });
      if (failCommitOnce) {
        failCommitOnce = false;
        throw new Error("phase1 commit failed");
      }
      return result;
    },
  };
  const sealed = {
    open: async (_u: string, _p: string, value: string) =>
      JSON.stringify(
        value === "rotated-by-peer"
          ? { access_token: "peer-token", refresh_token: "peer-r" }
          : { access_token: "a", refresh_token: "r" },
      ),
    seal: async () => "sealed2",
  };
  const t = new GitHubUserTokens(
    db as never,
    { clientId: "client" },
    {
      exchange: async () => {
        state = {
          ...state,
          credentials: "rotated-by-peer",
          expiresAt: new Date(NOW + 3_600_000),
          updatedAt: new Date(NOW + 50),
        };
        throw new GitHubUnauthorized();
      },
      revoke: async (token: string) => {
        revoked.push(token);
      },
    } as never,
    sealed as never,
    () => NOW,
  );

  await expect(t.withToken("u1", async (token) => token)).rejects.toThrow("phase1 commit failed");
  const next = await t.withToken("u1", async (token) => token);
  expect(next).toEqual({ ok: true, data: "peer-token" });
  expect(revoked).toEqual([]);
});
