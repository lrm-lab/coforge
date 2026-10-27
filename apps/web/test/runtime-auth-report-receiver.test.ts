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

function recorder(result = true) {
  const calls: [string, StoredRuntimeAuth][] = [];
  const announced: string[] = [];
  return {
    calls,
    announced,
    announce: async (computerId: string) => {
      announced.push(computerId);
    },
    store: {
      record: async (computerId: string, auth: StoredRuntimeAuth) => {
        calls.push([computerId, auth]);
        return result;
      },
    },
  };
}

test("stores the connection's Computer's report, keyed by provider", async () => {
  const { calls, store, announce } = recorder();
  const method = createRuntimeAuthReportMethod(store, announce);

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
  const { calls, store, announce } = recorder();
  const method = createRuntimeAuthReportMethod(store, announce);

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
  const { store, announce, announced } = recorder(false);
  const method = createRuntimeAuthReportMethod(store, announce);

  expect(await method(report(), { principal: principal() })).toBeInstanceOf(Uint8Array);
  expect(announced).toEqual([]);
});

test("a stored report is announced, so an open Computer page shows a sign-in without a reload", async () => {
  const { store, announce, announced } = recorder();
  const method = createRuntimeAuthReportMethod(store, announce);

  expect(await method(report(), { principal: principal() })).toBeInstanceOf(Uint8Array);
  expect(announced).toEqual(["computer-1"]);
});

test("a lost announcement still answers the report as stored", async () => {
  const { store } = recorder();
  const method = createRuntimeAuthReportMethod(store, async () => {
    throw new Error("Centrifugo is down");
  });

  expect(await method(report(), { principal: principal() })).toBeInstanceOf(Uint8Array);
});

test("refuses a malformed report, another Computer's, or an Agent's", async () => {
  const { calls, store, announce } = recorder();
  const method = createRuntimeAuthReportMethod(store, announce);

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
      record: async () => {
        throw new Error("database is down");
      },
    },
    async () => {},
  );

  expect(await method(report(), { principal: principal() })).toEqual({
    code: 503,
    message: "runtime auth status report was not recorded",
  });
});

test("a structurally invalid status report is refused before persistence", async () => {
  const { calls, store, announce } = recorder();
  const method = createRuntimeAuthReportMethod(store, announce);
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
  const { calls, store, announce } = recorder();
  const method = createRuntimeAuthReportMethod(store, announce);
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
