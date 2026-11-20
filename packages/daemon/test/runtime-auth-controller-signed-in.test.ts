import { expect, test } from "bun:test";
import type { RuntimeAuthAdapter, RuntimeAuthLoginResult } from "@lrm/coforge-anvil";
import { RuntimeAuthController } from "#src/daemon-runtime/runtime-auth-controller";

const scope = { protocolMajor: 1 as const, workspaceId: "workspace-a", computerId: "computer-a" };

/** A controller whose adapter ends its login with `result`, and the providers it said signed in. */
function subject(
  result: RuntimeAuthLoginResult,
  logoutResult: Awaited<ReturnType<RuntimeAuthAdapter["logout"]>> = {
    status: "logged_out",
    authStatus: { provider: "codex", state: "logged_out" },
  },
) {
  const signedIn: string[] = [];
  const signedOut: string[] = [];
  const adapter = {
    provider: "codex",
    startLogin: async () => result,
    readStatus: async () => ({ provider: "codex", state: "logged_in" }),
    submitCode: async () => {},
    cancel: async () => {},
    logout: async () => logoutResult,
  } as unknown as RuntimeAuthAdapter;
  const controller = new RuntimeAuthController({
    owner: scope,
    workingDirectory: "/fixture",
    createAdapter: () => adapter,
    reportLogin: async () => {},
    reportLogout: async () => {},
    refresh: async () => {},
  });
  controller.onSignedIn((provider) => void signedIn.push(provider));
  controller.onSignedOut((provider) => void signedOut.push(provider));
  const start = () =>
    controller.handle({
      ...scope,
      kind: "login_start",
      loginId: "rtl_abcdefghijklmnop",
      provider: "codex",
    });
  const logout = () =>
    controller.handle({
      ...scope,
      kind: "logout",
      requestId: "rlo_abcdefghijklmnop",
      provider: "codex",
    });
  return { controller, signedIn, signedOut, start, logout };
}

test("a login that signed in tells the runtime, once the status was read again", async () => {
  const { signedIn, start } = subject({
    status: "logged_in",
    authStatus: { provider: "codex", state: "logged_in" },
  });
  await start();
  expect(signedIn).toEqual(["codex"]);
});

test("a login that did not sign in tells nothing", async () => {
  const { signedIn, start } = subject({ status: "failed", reason: "rejected" });
  await start();
  expect(signedIn).toEqual([]);
});

test("a logout that signed out tells the runtime, once the status was read again", async () => {
  const { signedOut, logout } = subject({ status: "cancelled" });
  await logout();
  expect(signedOut).toEqual(["codex"]);
});

test("a logout that failed tells nothing", async () => {
  const { signedOut, logout } = subject(
    { status: "cancelled" },
    { status: "failed", reason: "still_logged_in" },
  );
  await logout();
  expect(signedOut).toEqual([]);
});
