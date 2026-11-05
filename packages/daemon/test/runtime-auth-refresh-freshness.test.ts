import { expect, test } from "bun:test";
import type {
  RuntimeAuthAdapter,
  RuntimeAuthProvider,
  RuntimeAuthStatus,
} from "@lrm/coforge-anvil";
import type { RuntimeAuthStatusReport } from "@lrm/coforge-sdk/internal";
import type { RuntimeMetadata } from "@lrm/coforge-sdk/internal";

import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import { RuntimeAuthController } from "#src/daemon-runtime/runtime-auth-controller";
import { RuntimeAuthReporter } from "#src/daemon-runtime/runtime-auth-reporter";

const owner = { protocolMajor: 1 as const, workspaceId: "workspace-a", computerId: "computer-a" };

/** One Antigravity account on the Computer, shared by every adapter the reporter builds. */
function subject() {
  const sent: RuntimeAuthStatusReport[] = [];
  const reads: string[] = [];
  const state = { signedIn: false };
  const adapter = {
    provider: "antigravity" as const,
    async readStatus(): Promise<RuntimeAuthStatus> {
      reads.push(state.signedIn ? "logged_in" : "logged_out");
      return { provider: "antigravity", state: state.signedIn ? "logged_in" : "logged_out" };
    },
    async startLogin() {
      state.signedIn = true;
      return {
        status: "logged_in" as const,
        authStatus: { provider: "antigravity" as const, state: "logged_in" as const },
      };
    },
    async submitCode() {},
    async logout() {
      state.signedIn = false;
      return { status: "logged_out" as const };
    },
  } as unknown as RuntimeAuthAdapter;
  const reporter = new RuntimeAuthReporter({
    owner: { workspaceId: owner.workspaceId, computerId: owner.computerId },
    workingDirectory: "/workspace",
    transport: () =>
      ({
        reportRuntimeAuthStatus: async (report: RuntimeAuthStatusReport) => {
          sent.push(report);
        },
      }) as unknown as DaemonConnectionClient,
    isStopping: () => false,
    createAdapter: () => adapter,
  });
  const controller = new RuntimeAuthController({
    owner: { ...owner },
    workingDirectory: "/workspace",
    createAdapter: () => adapter,
    async reportLogin() {},
    async reportLogout() {},
    refresh: (options) => reporter.refresh(options),
    refreshProvider: (provider: RuntimeAuthProvider, options) =>
      reporter.refreshProvider(provider, options),
  });
  const antigravity = () => sent.at(-1)!.runtimes.find((entry) => entry.provider === "antigravity");
  return { reporter, controller, sent, reads, state, antigravity };
}

test("a sign-in through the controller reports the runtime signed in in the same breath", async () => {
  const s = subject();
  await s.reporter.inventoryReported([
    { provider: "antigravity", version: "1.5.0", displayName: "Antigravity" },
  ] as RuntimeMetadata[]);
  expect(s.antigravity()?.state).toBe("logged_out");
  // A page open moments later would be throttled; a login landing never is.
  await s.controller.handle({
    ...owner,
    kind: "login_start",
    loginId: "rtl_agy_0123456789abcdef",
    provider: "antigravity",
    antigravityMethodId: "oauth-personal",
  });
  expect(s.antigravity()?.state).toBe("logged_in");
  s.controller.stop();
});

test("a sign-out through the controller reports the runtime signed out in the same breath", async () => {
  const s = subject();
  s.state.signedIn = true;
  await s.reporter.inventoryReported([
    { provider: "antigravity", version: "1.5.0", displayName: "Antigravity" },
  ] as RuntimeMetadata[]);
  expect(s.antigravity()?.state).toBe("logged_in");
  await s.controller.handle({
    ...owner,
    kind: "logout",
    requestId: "rtl_agy_0123456789abcdef",
    provider: "antigravity",
  });
  expect(s.antigravity()?.state).toBe("logged_out");
  s.controller.stop();
});

test("a page open re-reads a status the minute's throttle would otherwise keep", async () => {
  const s = subject();
  await s.reporter.inventoryReported([
    { provider: "antigravity", version: "1.5.0", displayName: "Antigravity" },
  ] as RuntimeMetadata[]);
  s.reads.length = 0;
  // Signed in on the Computer itself: nothing tells the daemon but the page open.
  s.state.signedIn = true;
  await s.controller.handle({ ...owner, kind: "status_read", provider: "antigravity" });
  expect(s.reads).toEqual(["logged_in"]);
  expect(s.antigravity()?.state).toBe("logged_in");
  s.controller.stop();
});
