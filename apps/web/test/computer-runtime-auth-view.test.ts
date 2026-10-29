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
/** The Computer's runtime rows as the view takes them: usable unless a test says otherwise. */
const runtimeRows = (providers: readonly string[]) => providers.map((provider) => ({ provider }));

test("a runtime that cannot be used shows no login state", () => {
  const view = runtimeAuthView(column, {
    showAccount: true,
    runtimes: [{ provider: "claude-code", unavailableCode: "start_failed" }, { provider: "codex" }],
  });
  expect(view["claude-code"]).toBeUndefined();
});

test("someone who may sign the runtimes in or out sees the account", () => {
  expect(runtimeAuthView(column, { showAccount: true, runtimes: runtimeRows(both) })).toEqual(
    column.runtimes,
  );
});

test("a runtime the viewer may not see brings no status", () => {
  expect(runtimeAuthView(column, { showAccount: true, runtimes: runtimeRows(["codex"]) })).toEqual({
    codex: { provider: "codex", state: "unavailable", unavailableReason: "version_unsupported" },
  });
});

test("everyone else gets the state alone: the account fields are absent, not hidden", () => {
  expect(runtimeAuthView(column, { showAccount: false, runtimes: runtimeRows(both) })).toEqual({
    "claude-code": { provider: "claude-code", state: "logged_in" },
    codex: { provider: "codex", state: "unavailable", unavailableReason: "version_unsupported" },
  });
});

test("a Computer that never reported, or a column that is not a report, shows nothing", () => {
  expect(runtimeAuthView(null, { showAccount: true, runtimes: runtimeRows(both) })).toEqual({});
  expect(
    runtimeAuthView({ runtimes: {} }, { showAccount: true, runtimes: runtimeRows(both) }),
  ).toEqual({});
  expect(parseStoredRuntimeAuth("nope")).toBeNull();
});

test("Command Code login state reaches the Computer page", () => {
  const stored = storedRuntimeAuth(1, [{ provider: "command-code", state: "logged_out" }]);
  expect(
    runtimeAuthView(stored, { showAccount: false, runtimes: runtimeRows(["command-code"]) }),
  ).toEqual({
    "command-code": { provider: "command-code", state: "logged_out" },
  });
});

test("a stored label that is not masked is dropped on read", () => {
  const stored = {
    collectedAtMs: 1,
    runtimes: {
      codex: { provider: "codex", state: "logged_in", account: { maskedLabel: "a@b.c" } },
    },
  };
  expect(runtimeAuthView(stored, { showAccount: true, runtimes: runtimeRows(both) })).toEqual({
    codex: { provider: "codex", state: "logged_in" },
  });
});
