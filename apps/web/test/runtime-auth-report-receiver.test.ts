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

test("sanitizes again on receipt: an unmasked label is dropped, a provider without a login flow is ignored", async () => {
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
