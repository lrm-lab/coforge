import { expect, test } from "bun:test";
import {
  encodeRuntimeAuthStatusReport,
  type RuntimeAuthStatusReport,
} from "@lrm/coforge-sdk/internal";

import { createRuntimeAuthReportMethod } from "#src/server/centrifugo/runtime-auth-report-receiver.server";
import {
  parseRuntimeAuthSignal,
  runtimeAuthChannel,
} from "#src/features/computers/runtime-auth-realtime";
import {
  runtimeAuthChangeAnnouncer,
  runtimeAuthScanEnder,
  type StoredRuntimeAuth,
} from "#src/server/computers/computer-runtime-auth.server";

const principal = () => ({
  userId: "user-1",
  workspaceId: "workspace-1",
  computerId: "computer-1",
});

const report = (overrides: Partial<RuntimeAuthStatusReport> = {}) =>
  encodeRuntimeAuthStatusReport({
    protocolMajor: 1,
    requestId: "auth-1",
    workspaceId: "workspace-1",
    computerId: "computer-1",
    collectedAtMs: 1_000,
    runtimes: [
      {
        provider: "claude-code",
        state: "logged_in",
        account: { maskedLabel: "f***@example.com", planLabel: "Max" },
      },
      { provider: "codex", state: "logged_out" },
    ],
    ...overrides,
  });

/** What the Computer's stored report was before this one: `previous`, or nothing yet. */
function recorder(result = true, previous: StoredRuntimeAuth | null = null) {
  const calls: [string, StoredRuntimeAuth][] = [];
  const events: string[] = [];
  const ended: [string, string[]][] = [];
  return {
    calls,
    events,
    ended,
    announce: async (computerId: string) => {
      events.push(`announce:${computerId}`);
    },
    end: async (computerId: string, providers: string[]) => {
      events.push("end");
      ended.push([computerId, providers]);
    },
    store: {
      read: async () => previous,
      record: async (computerId: string, auth: StoredRuntimeAuth) => {
        calls.push([computerId, auth]);
        return result;
      },
    },
  };
}

test("stores the connection's Computer's report, keyed by provider", async () => {
  const { calls, store, announce, end } = recorder();
  const method = createRuntimeAuthReportMethod(store, announce, end);

  expect(await method(report(), { principal: principal() })).toBeInstanceOf(Uint8Array);
  expect(calls).toEqual([
    [
      "computer-1",
      {
        collectedAtMs: 1_000,
        runtimes: {
          "claude-code": {
            provider: "claude-code",
            state: "logged_in",
            account: { maskedLabel: "f***@example.com", planLabel: "Max" },
          },
          codex: { provider: "codex", state: "logged_out" },
        },
      },
    ],
  ]);
});

test("sanitizes again on receipt: an unmasked label is dropped, an unknown provider is retained", async () => {
  const { calls, store, announce, end } = recorder();
  const method = createRuntimeAuthReportMethod(store, announce, end);

  await method(
    report({
      runtimes: [
        {
          provider: "claude-code",
          state: "logged_in",
          account: { maskedLabel: "frank@example.com" },
        },
        { provider: "pi", state: "logged_in" },
      ],
    }),
    { principal: principal() },
  );
  expect(calls[0]?.[1].runtimes).toEqual({
    "claude-code": { provider: "claude-code", state: "logged_in" },
    pi: { provider: "pi", state: "logged_in" },
  });
});

test("an older report than the stored one is accepted and ignored", async () => {
  const { store, announce, end, events } = recorder(false);
  const method = createRuntimeAuthReportMethod(store, announce, end);

  expect(await method(report(), { principal: principal() })).toBeInstanceOf(Uint8Array);
  expect(events).toEqual([]);
});

test("a stored report is announced, so an open Computer page shows a sign-in without a reload", async () => {
  const { store, announce, end, events } = recorder();
  const method = createRuntimeAuthReportMethod(store, announce, end);

  expect(await method(report(), { principal: principal() })).toBeInstanceOf(Uint8Array);
  expect(events.at(-1)).toBe("announce:computer-1");
});

test("a lost announcement still answers the report as stored", async () => {
  const { store, end } = recorder();
  const method = createRuntimeAuthReportMethod(
    store,
    async () => {
      throw new Error("Centrifugo is down");
    },
    end,
  );

  expect(await method(report(), { principal: principal() })).toBeInstanceOf(Uint8Array);
});

test("refuses a malformed report, another Computer's, or an Agent's", async () => {
  const { calls, store, announce, end } = recorder();
  const method = createRuntimeAuthReportMethod(store, announce, end);

  expect(await method(new Uint8Array([1, 2, 3]), { principal: principal() })).toMatchObject({
    code: 400,
  });
  expect(
    await method(report({ computerId: "computer-2" }), { principal: principal() }),
  ).toMatchObject({ code: 403 });
  expect(
    await method(report(), { principal: { ...principal(), agentId: "agent-1" } }),
  ).toMatchObject({ code: 403 });
  expect(calls).toEqual([]);
});

test("a report that could not be stored answers 503", async () => {
  const method = createRuntimeAuthReportMethod(
    {
      read: async () => null,
      record: async () => {
        throw new Error("database is down");
      },
    },
    async () => {},
    async () => {},
  );

  expect(await method(report(), { principal: principal() })).toEqual({
    code: 503,
    message: "runtime auth status report was not recorded",
  });
});

test("a structurally invalid status report is refused before persistence", async () => {
  const { calls, store, announce, end } = recorder();
  const method = createRuntimeAuthReportMethod(store, announce, end);
  for (const runtimes of [
    [
      { provider: "codex", state: "unknown" as const },
      { provider: "codex", state: "logged_in" as const },
    ],
    Array.from({ length: 33 }, (_, i) => ({ provider: `future-${i}`, state: "unknown" as const })),
  ]) {
    expect(await method(report({ runtimes }), { principal: principal() })).toMatchObject({
      code: 400,
    });
  }
  expect(calls).toEqual([]);
});

test("a report with one invalid provider still records the valid runtime", async () => {
  const { calls, store, announce, end } = recorder();
  const method = createRuntimeAuthReportMethod(store, announce, end);
  expect(
    await method(
      report({
        runtimes: [
          { provider: "bad provider", state: "unknown" },
          { provider: "kiro", state: "logged_in" },
        ],
      }),
      { principal: principal() },
    ),
  ).toBeInstanceOf(Uint8Array);
  expect(calls[0]?.[1].runtimes).toEqual({ kiro: { provider: "kiro", state: "logged_in" } });
});

const stored = (
  runtimes: StoredRuntimeAuth["runtimes"],
  collectedAtMs = 500,
): StoredRuntimeAuth => ({
  collectedAtMs,
  runtimes,
});
const claudeIn = {
  provider: "claude-code",
  state: "logged_in",
  account: { maskedLabel: "f***@example.com", planLabel: "Max" },
} as const;
const codexOut = { provider: "codex", state: "logged_out" } as const;

test("a login that changed ends the scans of its runtimes before the page is told, and only those", async () => {
  // Codex was signed in before this report signed it out; Claude Code is as it was.
  const before = stored({
    "claude-code": claudeIn,
    codex: { provider: "codex", state: "logged_in" },
  });
  const { store, announce, end, events, ended } = recorder(true, before);
  const method = createRuntimeAuthReportMethod(store, announce, end);

  await method(report(), { principal: principal() });
  expect(ended).toEqual([["computer-1", ["codex"]]]);
  expect(events).toEqual(["end", "announce:computer-1"]);
});

test("a report that changes nothing, however new, leaves a running scan alone", async () => {
  // The plan label is not the login: only the state and the account are.
  const before = stored({
    "claude-code": { ...claudeIn, account: { maskedLabel: "f***@example.com", planLabel: "Pro" } },
    codex: codexOut,
  });
  const { store, announce, end, ended } = recorder(true, before);
  const method = createRuntimeAuthReportMethod(store, announce, end);
  await method(report({ collectedAtMs: 9_000 }), { principal: principal() });
  expect(ended).toEqual([]);
});

test("a different account, a first report and an unreadable earlier one each end the scans they touch", async () => {
  const other = stored({
    "claude-code": { ...claudeIn, account: { maskedLabel: "g***@example.com" } },
    codex: codexOut,
  });
  for (const [previous, providers] of [
    [other, ["claude-code"]],
    [null, ["claude-code", "codex"]],
  ] as const) {
    const { store, announce, end, ended } = recorder(true, previous);
    await createRuntimeAuthReportMethod(
      store,
      announce,
      end,
    )(report(), {
      principal: principal(),
    });
    expect(ended).toEqual([["computer-1", [...providers]]]);
  }
  const { store, announce, end, ended } = recorder();
  store.read = async () => {
    throw new Error("database is down");
  };
  await createRuntimeAuthReportMethod(store, announce, end)(report(), { principal: principal() });
  expect(ended).toEqual([["computer-1", ["claude-code", "codex"]]]);
});

test("a scan that could not be ended never costs the report or the announcement", async () => {
  const { store, announce, events } = recorder();
  const method = createRuntimeAuthReportMethod(store, announce, async () => {
    throw new Error("redis is down");
  });
  expect(await method(report(), { principal: principal() })).toBeInstanceOf(Uint8Array);
  expect(events).toEqual(["announce:computer-1"]);
});

test("every Workspace the Computer is in loses its running scan of a changed runtime", async () => {
  const ended: object[] = [];
  const end = runtimeAuthScanEnder(
    {
      workspaceComputer: {
        findMany: async (query: unknown) => {
          expect(query).toEqual({
            where: { computerId: "computer-1" },
            select: { workspaceId: true },
          });
          return [{ workspaceId: "workspace-1" }, { workspaceId: "workspace-2" }];
        },
      },
    } as never,
    { endScan: async (key) => void ended.push(key) },
  );

  await end("computer-1", ["codex"]);
  expect(ended).toEqual([
    { workspaceId: "workspace-1", computerId: "computer-1", provider: "codex" },
    { workspaceId: "workspace-2", computerId: "computer-1", provider: "codex" },
  ]);
});

test("a change is announced once to every member of each Workspace the Computer is in", async () => {
  const queries: unknown[] = [];
  const sent: [string[], unknown][] = [];
  const announce = runtimeAuthChangeAnnouncer(
    {
      workspaceMembership: {
        findMany: async (query: unknown) => {
          queries.push(query);
          return [{ userId: "owner" }, { userId: "member" }];
        },
      },
    } as never,
    { broadcast: async (channels, data) => void sent.push([channels, data]) },
  );

  await announce("computer-1");
  expect(queries).toEqual([
    {
      where: { workspace: { computers: { some: { computerId: "computer-1" } } } },
      select: { userId: true },
      distinct: ["userId"],
    },
  ]);
  expect(sent).toEqual([
    [
      [runtimeAuthChannel("owner"), runtimeAuthChannel("member")],
      { type: "runtime-auth.status.v1", computerId: "computer-1" },
    ],
  ]);
});

test("the page takes a status signal, and still drops anything else", () => {
  const status = { type: "runtime-auth.status.v1", computerId: "computer-1" } as const;
  expect(parseRuntimeAuthSignal(status)).toEqual(status);
  expect(parseRuntimeAuthSignal(new TextEncoder().encode(JSON.stringify(status)))).toEqual(status);
  expect(parseRuntimeAuthSignal({ type: "runtime-auth.other.v1" })).toBeUndefined();
  expect(parseRuntimeAuthSignal(new Uint8Array([1]))).toBeUndefined();
});
