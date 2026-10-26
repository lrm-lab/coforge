import { expect, test } from "bun:test";
import {
  encodeRuntimeAuthStatusReport,
  type RuntimeAuthStatusReport,
} from "@lrm/coforge-sdk/internal";

import { createRuntimeAuthReportMethod } from "#src/server/centrifugo/runtime-auth-report-receiver.server";
import type { StoredRuntimeAuth } from "#src/server/computers/computer-runtime-auth.server";

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
  return {
    calls,
    store: {
      record: async (computerId: string, auth: StoredRuntimeAuth) => {
        calls.push([computerId, auth]);
        return result;
      },
    },
  };
}

test("stores the connection's Computer's report, keyed by provider", async () => {
  const { calls, store } = recorder();
  const method = createRuntimeAuthReportMethod(store);

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
  const { calls, store } = recorder();
  const method = createRuntimeAuthReportMethod(store);

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
  const { store } = recorder(false);
  const method = createRuntimeAuthReportMethod(store);

  expect(await method(report(), { principal: principal() })).toBeInstanceOf(Uint8Array);
});

test("refuses a malformed report, another Computer's, or an Agent's", async () => {
  const { calls, store } = recorder();
  const method = createRuntimeAuthReportMethod(store);

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
  const method = createRuntimeAuthReportMethod({
    record: async () => {
      throw new Error("database is down");
    },
  });

  expect(await method(report(), { principal: principal() })).toEqual({
    code: 503,
    message: "runtime auth status report was not recorded",
  });
});

test("a structurally invalid status report is refused before persistence", async () => {
  const { calls, store } = recorder();
  const method = createRuntimeAuthReportMethod(store);
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
  const { calls, store } = recorder();
  const method = createRuntimeAuthReportMethod(store);
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
