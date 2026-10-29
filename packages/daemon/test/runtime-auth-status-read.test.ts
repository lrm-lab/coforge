import { expect, test } from "bun:test";
import type { RuntimeAuthAdapter } from "@lrm/coforge-anvil";
import { RuntimeAuthController } from "#src/daemon-runtime/runtime-auth-controller";

const scope = { protocolMajor: 1 as const, workspaceId: "workspace-1", computerId: "computer-1" };

function subject(refreshProvider?: (provider: string) => Promise<void>) {
  const requested: string[] = [];
  let starts = 0;
  let refreshed = 0;
  const controller = new RuntimeAuthController({
    owner: scope,
    workingDirectory: "/fixture",
    createAdapter: () =>
      ({
        provider: "codex",
        async startLogin() {
          starts++;
          return { status: "cancelled" };
        },
        async readStatus() {
          return { provider: "codex", state: "logged_out" };
        },
        async submitCode() {},
        async cancel() {},
        async logout() {
          return { status: "logged_out" };
        },
      }) as unknown as RuntimeAuthAdapter,
    reportLogin: async () => {},
    reportLogout: async () => {},
    refresh: async () => {
      refreshed++;
    },
    ...(refreshProvider
      ? {
          refreshProvider: async (provider: string) => {
            requested.push(provider);
            await refreshProvider(provider);
          },
        }
      : {}),
  });
  return { controller, requested, starts: () => starts, refreshed: () => refreshed };
}

test("a status read asks only that runtime to be read again, and starts no login", async () => {
  const daemon = subject(async () => {});
  await daemon.controller.handle({ ...scope, kind: "status_read", provider: "codex" });
  await daemon.controller.handle({ ...scope, kind: "status_read", provider: "claude-code" });
  expect(daemon.requested).toEqual(["codex", "claude-code"]);
  expect(daemon.starts()).toBe(0);
  expect(daemon.refreshed()).toBe(0);
});

test("a host that cannot read one runtime refreshes them all instead", async () => {
  const daemon = subject();
  await daemon.controller.handle({ ...scope, kind: "status_read", provider: "codex" });
  expect(daemon.refreshed()).toBe(1);
});

test("another Workspace's or Computer's status read is ignored", async () => {
  const daemon = subject(async () => {});
  await daemon.controller.handle({
    ...scope,
    computerId: "computer-2",
    kind: "status_read",
    provider: "codex",
  });
  await daemon.controller.handle({
    ...scope,
    workspaceId: "workspace-2",
    kind: "status_read",
    provider: "codex",
  });
  expect(daemon.requested).toEqual([]);
});
