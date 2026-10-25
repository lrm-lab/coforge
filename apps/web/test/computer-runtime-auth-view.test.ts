import { expect, test } from "bun:test";

import {
  parseStoredRuntimeAuth,
  runtimeAuthView,
  storedRuntimeAuth,
} from "#src/server/computers/computer-runtime-auth.server";

const column = storedRuntimeAuth(5, [
  {
    provider: "claude-code",
    state: "logged_in",
    account: { maskedLabel: "f***@example.com", planLabel: "Max", methodLabel: "Claude account" },
  },
  { provider: "codex", state: "unavailable", unavailableReason: "version_unsupported" },
]);

const both = ["claude-code", "codex"];

test("someone who may sign the runtimes in or out sees the account", () => {
  expect(runtimeAuthView(column, { showAccount: true, visibleProviders: both })).toEqual(
    column.runtimes,
  );
});

test("a runtime the viewer may not see brings no status", () => {
  expect(runtimeAuthView(column, { showAccount: true, visibleProviders: ["codex"] })).toEqual({
    codex: column.runtimes.codex,
  });
});

test("everyone else gets the state alone: the account fields are absent, not hidden", () => {
  expect(runtimeAuthView(column, { showAccount: false, visibleProviders: both })).toEqual({
    "claude-code": { provider: "claude-code", state: "logged_in" },
    codex: { provider: "codex", state: "unavailable", unavailableReason: "version_unsupported" },
  });
});

test("a Computer that never reported, or a column that is not a report, shows nothing", () => {
  expect(runtimeAuthView(null, { showAccount: true, visibleProviders: both })).toEqual({});
  expect(runtimeAuthView({ runtimes: {} }, { showAccount: true, visibleProviders: both })).toEqual(
    {},
  );
  expect(parseStoredRuntimeAuth("nope")).toBeNull();
});

test("a stored label that is not masked is dropped on read", () => {
  const stored = {
    collectedAtMs: 1,
    runtimes: {
      codex: { provider: "codex", state: "logged_in", account: { maskedLabel: "a@b.c" } },
    },
  };
  expect(runtimeAuthView(stored, { showAccount: true, visibleProviders: both })).toEqual({
    codex: { provider: "codex", state: "logged_in" },
  });
});
