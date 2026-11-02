import { expect, test } from "bun:test";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";

import { runtimeSignInNotice } from "#src/features/agents/agent-runtime-sign-in-state";

const loggedOut = (provider: "claude-code" | "kiro" | "command-code") => ({
  displayName: "s144",
  ownedByCurrentUser: true,
  runtimeAuth: { [provider]: { provider, state: "logged_out" as const } },
});

test("a runtime reported signed out gets the notice, with Sign in for the Computer's owner", () => {
  expect(runtimeSignInNotice(loggedOut("claude-code"), RUNTIME_PROVIDER.CLAUDE_CODE)).toEqual({
    signInProvider: "claude-code",
  });
});

test("a Workspace admin who does not own the Computer may sign it in too", () => {
  const computer = {
    ...loggedOut("claude-code"),
    ownedByCurrentUser: false,
    canManageAgents: true,
  };
  expect(runtimeSignInNotice(computer, RUNTIME_PROVIDER.CLAUDE_CODE)?.signInProvider).toBe(
    "claude-code",
  );
});

test("anyone else is told it is signed out, with no Sign in", () => {
  const computer = { ...loggedOut("claude-code"), ownedByCurrentUser: false };
  expect(runtimeSignInNotice(computer, RUNTIME_PROVIDER.CLAUDE_CODE)).toEqual({});
});

test("signed in, unknown or unreported says nothing", () => {
  const computer = (state: "logged_in" | "unknown") => ({
    displayName: "s144",
    ownedByCurrentUser: true,
    runtimeAuth: { "claude-code": { provider: "claude-code" as const, state } },
  });
  expect(runtimeSignInNotice(computer("logged_in"), RUNTIME_PROVIDER.CLAUDE_CODE)).toBeUndefined();
  expect(runtimeSignInNotice(computer("unknown"), RUNTIME_PROVIDER.CLAUDE_CODE)).toBeUndefined();
  expect(
    runtimeSignInNotice(
      { displayName: "s144", ownedByCurrentUser: true },
      RUNTIME_PROVIDER.CLAUDE_CODE,
    ),
  ).toBeUndefined();
});

test("a runtime with no login state, such as Pi, says nothing", () => {
  expect(runtimeSignInNotice(loggedOut("claude-code"), RUNTIME_PROVIDER.PI)).toBeUndefined();
});

test("Kiro on Windows and Command Code are told, but signed in elsewhere", () => {
  expect(
    runtimeSignInNotice({ ...loggedOut("kiro"), platform: "win32" }, RUNTIME_PROVIDER.KIRO),
  ).toEqual({});
  expect(runtimeSignInNotice(loggedOut("command-code"), RUNTIME_PROVIDER.COMMAND_CODE)).toEqual({});
});
