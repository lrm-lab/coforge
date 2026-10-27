import { afterAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeAuthStatusReport } from "@lrm/coforge-sdk/internal";
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
        async stop() {},
      }),
    },
    undefined,
    {
      // Only a provider without a login flow: no adapter runs a provider CLI.
      runtimes: async () => [{ provider: "pi", version: "1.0.0", displayName: "Pi" }],
      cachedCatalogs: async () => ({ catalogs: [], needsRefresh: false }),
      catalogs: async () => [],
    },
  );
  await runtime.start(connection);
  await Bun.sleep(0);
  return { runtime, reports, order };
}

test("the runtime reports login status after its inventory, then again on demand", async () => {
  const { runtime, reports, order } = await startedRuntime();
  expect(order).toEqual(["inventory", "auth"]);
  expect(reports).toHaveLength(1);
  expect(reports[0]).toMatchObject({ workspaceId: "workspace-a", computerId: "computer-a" });
  expect(reports[0]!.runtimes.map((entry) => entry.state)).toEqual([
    "unavailable",
    "unavailable",
    "unavailable",
    "unavailable",
  ]);

  await runtime.refreshRuntimeAuth();
  expect(reports).toHaveLength(2);
  await runtime.stop();
});

test("a server that refuses the report leaves the runtime running", async () => {
  const { runtime } = await startedRuntime({ refuse: true });
  await expect(runtime.refreshRuntimeAuth()).resolves.toBeUndefined();
  await runtime.stop();
});
