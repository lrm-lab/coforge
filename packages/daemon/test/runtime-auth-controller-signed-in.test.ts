import { expect, test } from "bun:test";
import type { RuntimeAuthAdapter, RuntimeAuthLoginResult } from "@lrm/coforge-anvil";
import { RuntimeAuthController } from "#src/daemon-runtime/runtime-auth-controller";

const scope = { protocolMajor: 1 as const, workspaceId: "workspace-a", computerId: "computer-a" };

/** A controller whose adapter ends its login with `result`, and the providers it said signed in. */
function subject(result: RuntimeAuthLoginResult) {
  const signedIn: string[] = [];
  const adapter = {
    provider: "codex",
    startLogin: async () => result,
    readStatus: async () => ({ provider: "codex", state: "logged_in" }),
    submitCode: async () => {},
    cancel: async () => {},
    logout: async () => ({
      status: "logged_out",
      authStatus: { provider: "codex", state: "logged_out" },
    }),
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
  const start = () =>
    controller.handle({
      ...scope,
      kind: "login_start",
      loginId: "rtl_abcdefghijklmnop",
      provider: "codex",
    });
  return { controller, signedIn, start };
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
