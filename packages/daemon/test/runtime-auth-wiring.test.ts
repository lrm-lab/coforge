import { afterAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeAuthAdapter } from "@lrm/coforge-anvil";
import type { RuntimeAuthIntent, RuntimeAuthStatusReport } from "@lrm/coforge-sdk/internal";
import { DaemonRuntime, type WorkspaceConfig } from "#src/daemon-runtime/runtime";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";

const workspaceRoot = join(realpathSync(tmpdir()), `coforge-auth-wiring-${crypto.randomUUID()}`);
afterAll(() => rm(workspaceRoot, { recursive: true, force: true }));

const connection: WorkspaceConfig = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
  workspaceRoot,
};

async function startedRuntime(options: { refuse?: boolean } = {}) {
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  const reports: RuntimeAuthStatusReport[] = [];
  const order: string[] = [];
  let signedIn = false;
  const intents: ((intent: RuntimeAuthIntent) => void)[] = [];
  const runtime = new DaemonRuntime(
    connection,
    () => {
      throw new Error("no agent session expected");
    },
    credentials,
    {
      create: () => ({
        async start() {},
        async ready() {},
        async updateCodeAgents() {
          order.push("inventory");
        },
        async reportRuntimeAuthStatus(report: RuntimeAuthStatusReport) {
          order.push("auth");
          if (options.refuse) throw new Error("404 unknown RPC method");
          reports.push(report);
        },
        onRuntimeAuth(listener: (intent: RuntimeAuthIntent) => void) {
          intents.push(listener);
          return () => {};
        },
        async reportRuntimeAuthLogin() {},
        async reportRuntimeAuthLogout() {},
        async stop() {},
      }),
    },
    undefined,
    {
      // One provider with a login flow, whose adapter is the fake below: no CLI runs.
      runtimes: async () => [{ provider: "codex", version: "0.165.0", displayName: "Codex" }],
      cachedCatalogs: async () => ({ catalogs: [], needsRefresh: false }),
      catalogs: async () => [],
    },
    undefined,
    undefined,
    undefined,
    undefined,
    () =>
      ({
        provider: "codex",
        async readStatus() {
          return signedIn
            ? {
                provider: "codex",
                state: "logged_in",
                account: { maskedLabel: "f****@example.com" },
              }
            : { provider: "codex", state: "logged_out" };
        },
        async startLogin() {
          return { status: "cancelled" };
        },
        async submitCode() {},
        async cancel() {},
        async logout() {
          return { status: "logged_out" };
        },
      }) as unknown as RuntimeAuthAdapter,
  );
  await runtime.start(connection);
  await Bun.sleep(10);
  const statusRead = async (provider = "codex") => {
    for (const listener of intents)
      listener({
        protocolMajor: 1,
        workspaceId: connection.workspaceId,
        computerId: connection.computerId,
        kind: "status_read",
        provider: provider as "codex",
      });
    // The controller handles an intent without blocking the transport's listener.
    await Bun.sleep(20);
  };
  return { runtime, reports, order, statusRead, signIn: () => (signedIn = true) };
}

test("the runtime reports login status after its inventory, then again on demand", async () => {
  const daemon = await startedRuntime();
  expect(daemon.order).toEqual(["inventory", "auth"]);
  expect(daemon.reports).toHaveLength(1);
  expect(daemon.reports[0]).toMatchObject({
    workspaceId: "workspace-a",
    computerId: "computer-a",
  });
  expect(daemon.reports[0]!.runtimes.map((entry) => entry.state)).toEqual([
    "unavailable",
    "logged_out",
    "unavailable",
    "unavailable",
    "unavailable",
  ]);

  // Signed in with its own CLI on the Computer: opening its page asks for one more read.
  daemon.signIn();
  await daemon.statusRead();
  expect(daemon.reports).toHaveLength(2);
  expect(daemon.reports[1]!.runtimes.map((entry) => entry.state)).toEqual([
    "unavailable",
    "logged_in",
    "unavailable",
    "unavailable",
    "unavailable",
  ]);
  await daemon.runtime.stop();
});

test("a server that refuses the report leaves the runtime running", async () => {
  const daemon = await startedRuntime({ refuse: true });
  await expect(daemon.statusRead()).resolves.toBeUndefined();
  expect(daemon.order).toEqual(["inventory", "auth", "auth"]);
  await daemon.runtime.stop();
});
