import { expect, test } from "bun:test";
import type { RuntimeAuthAdapter } from "@lrm/coforge-anvil";
import { RuntimeAuthController } from "#src/daemon-runtime/runtime-auth-controller";
test("the Antigravity account choice crosses the controller into startLogin", async () => {
  const owner = { protocolMajor: 1 as const, workspaceId: "workspace-a", computerId: "computer-a" };
  let seen: string | undefined;
  const adapter: RuntimeAuthAdapter = {
    provider: "antigravity",
    async startLogin(options) {
      seen = (options as { antigravityMethodId?: string }).antigravityMethodId;
      return { status: "logged_in", authStatus: { provider: "antigravity", state: "logged_in" } };
    },
    async readStatus() {
      return { provider: "antigravity", state: "unknown" };
    },
    async submitCode() {},
    async cancel() {},
    async logout() {
      return { status: "failed", reason: "process_failed" };
    },
  };
  const controller = new RuntimeAuthController({
    owner,
    workingDirectory: "/fixture",
    createAdapter: () => adapter,
    async reportLogin() {},
    async reportLogout() {},
    async refresh() {},
  });
  await controller.handle({
    ...owner,
    kind: "login_start",
    loginId: "rtl_agy_1234567890abcd",
    provider: "antigravity",
    antigravityMethodId: "oauth-business",
  });
  expect(seen).toBe("oauth-business");
  controller.stop();
});
