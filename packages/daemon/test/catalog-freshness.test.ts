import { expect, test } from "bun:test";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import {
  CatalogFreshnessSweep,
  type CatalogFreshnessSweepPorts,
} from "#src/daemon-runtime/catalog-freshness-sweep";
import { CodeAgentInventorySync } from "#src/daemon-runtime/code-agent-inventory-sync";
import {
  CATALOG_RETRY_BASE_MS,
  CATALOG_RETRY_MAX_MS,
  CatalogRetrySchedule,
} from "#src/daemon-runtime/catalog-retry-schedule";
import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";

const transport = {} as DaemonConnectionClient;

function ports(overrides: Partial<CatalogFreshnessSweepPorts> = {}) {
  const rechecked: DaemonConnectionClient[] = [];
  const p: CatalogFreshnessSweepPorts = {
    transport: () => transport,
    recheck: async (value) => {
      rechecked.push(value);
    },
    ...overrides,
  };
  return { p, rechecked };
}

test("a sweep re-checks the catalogs of the live connection", async () => {
  const { p, rechecked } = ports();
  await new CatalogFreshnessSweep(p).sweep();
  expect(rechecked).toEqual([transport]);
});

test("a runtime that is not up has nothing to re-check", async () => {
  const { p, rechecked } = ports({ transport: () => undefined });
  await new CatalogFreshnessSweep(p).sweep();
  expect(rechecked).toEqual([]);
});

test("a failed check does not reject the sweep", async () => {
  const { p } = ports({
    recheck: async () => {
      throw new Error("discovery failed");
    },
  });
  await expect(new CatalogFreshnessSweep(p).sweep()).resolves.toBeUndefined();
});

test("concurrent sweeps join rather than repeat", async () => {
  let calls = 0;
  const { p } = ports({
    recheck: async () => {
      calls++;
      await Bun.sleep(20);
    },
  });
  const sweep = new CatalogFreshnessSweep(p);
  await Promise.all([sweep.sweep(), sweep.sweep(), sweep.sweep()]);
  expect(calls).toBe(1);
});

/** The model a `agy models` scan only lists once the account is signed in. */
const signedInModel = {
  id: "gemini-3.8-flash-medium",
  displayName: "Gemini 3.8 Flash (Medium)",
  description: "",
  modelProvider: "",
  reasoningEfforts: [],
  defaultReasoning: "",
  recommended: false,
};

function inventory(changed: RuntimeProvider[][]) {
  const updates: unknown[] = [];
  const discovered: unknown[] = [];
  // The first read is the one `reportRuntimes` makes, before anything could have changed.
  let reads = 0;
  const sync = new CodeAgentInventorySync(
    {
      runtimes: async () => [{ provider: "antigravity", version: "1.4.11", displayName: "agy" }],
      cachedCatalogs: async () => ({
        catalogs: [],
        needsRefresh: true,
        changedProviders: reads++ === 0 ? [] : (changed.shift() ?? []),
      }),
      catalogs: async (runtimes) => {
        discovered.push(runtimes);
        return { catalogs: [{ provider: "antigravity", models: [signedInModel] }], failures: [] };
      },
    },
    { workspaceId: "workspace-a", computerId: "computer-a" },
    () => true,
  );
  const live = {
    async updateCodeAgents(request: unknown) {
      updates.push(request);
    },
  } as unknown as DaemonConnectionClient;
  return { sync, live, updates, discovered };
}

test("a catalog whose on-disk key changed is re-discovered and re-reported", async () => {
  const { sync, live, updates, discovered } = inventory([[], ["antigravity"]]);
  await sync.reportRuntimes(live);
  expect(updates).toHaveLength(1);

  // Nothing changed: the sweep reads the keys and stops there, no provider spawned.
  await sync.recheckCatalogs(live);
  expect(discovered).toEqual([]);
  expect(updates).toHaveLength(1);

  // A sign-in or an update moved the key: the changed catalog is discovered again.
  await sync.recheckCatalogs(live);
  // The refresh runs on the inventory's serialized chain, behind the answered check.
  for (let wait = 0; wait < 50 && (discovered.length === 0 || updates.length < 2); wait++)
    await Bun.sleep(5);
  expect(discovered).toHaveLength(1);
  expect(updates.length).toBeGreaterThanOrEqual(2);
  expect(updates.at(-1)).toMatchObject({
    catalogs: [{ provider: "antigravity", models: [signedInModel] }],
  });
});

test("before an inventory is reported a freshness check has nothing to compare", async () => {
  const { sync, live, discovered } = inventory([["antigravity"]]);
  await sync.recheckCatalogs(live);
  expect(discovered).toEqual([]);
});

test("a provider whose catalog probe failed is retried alone after its backoff", async () => {
  const updates: unknown[] = [];
  const scoped: string[] = [];
  let fail = true;
  const sync = new CodeAgentInventorySync(
    {
      runtimes: async () => [{ provider: "antigravity", version: "1.4.11", displayName: "agy" }],
      cachedCatalogs: async () => ({ catalogs: [], needsRefresh: false, changedProviders: [] }),
      catalogs: async (_runtimes, options) => {
        if (!options?.provider) throw new Error("the retry path must scope its discovery");
        scoped.push(options.provider);
        if (fail) {
          fail = false;
          return { catalogs: [], failures: [{ provider: "antigravity", code: "unknown" }] };
        }
        return { catalogs: [{ provider: "antigravity", models: [signedInModel] }], failures: [] };
      },
    },
    { workspaceId: "workspace-a", computerId: "computer-a" },
    () => true,
  );
  const live = {
    async updateCodeAgents(request: unknown) {
      updates.push(request);
    },
    async sendProviderModelRefreshResult() {},
  } as unknown as DaemonConnectionClient;
  await sync.reportRuntimes(live);
  const start = Date.now();
  // A refresh that fails records the provider as due for another try.
  await sync.refreshModels(
    {
      protocolMajor: 1,
      requestId: "refresh-1",
      workspaceId: "workspace-a",
      computerId: "computer-a",
      provider: "antigravity",
    },
    live,
  );
  expect(scoped).toEqual(["antigravity"]);

  // Before its first wait elapses nothing is spawned.
  await sync.recheckCatalogs(live, start + 60_000);
  expect(scoped).toEqual(["antigravity"]);

  // Five minutes later that provider alone is probed again, and its catalog is reported.
  await sync.recheckCatalogs(live, start + 5 * 60_000 + 1_000);
  expect(scoped).toEqual(["antigravity", "antigravity"]);
  expect(updates.at(-1)).toMatchObject({
    catalogs: [{ provider: "antigravity", models: [signedInModel] }],
  });

  // It succeeded: no later sweep probes it again.
  await sync.recheckCatalogs(live, start + 60 * 60_000);
  expect(scoped).toHaveLength(2);
});

test("a repeated failure waits twice as long, up to an hour", () => {
  const schedule = new CatalogRetrySchedule();
  const failure = { provider: "antigravity" as const };
  const start = 1_000_000;
  schedule.settle([failure], [], start);
  expect(schedule.due(start + CATALOG_RETRY_BASE_MS - 1)).toEqual([]);
  expect(schedule.due(start + CATALOG_RETRY_BASE_MS)).toEqual(["antigravity"]);
  schedule.settle([failure], [], start);
  expect(schedule.due(start + CATALOG_RETRY_BASE_MS)).toEqual([]);
  expect(schedule.due(start + 2 * CATALOG_RETRY_BASE_MS)).toEqual(["antigravity"]);
  for (let attempt = 0; attempt < 10; attempt++) schedule.settle([failure], [], start);
  expect(schedule.due(start + CATALOG_RETRY_MAX_MS - 1)).toEqual([]);
  expect(schedule.due(start + CATALOG_RETRY_MAX_MS)).toEqual(["antigravity"]);
  // A catalog that reports clears the wait entirely.
  schedule.settle([], [{ provider: "antigravity" }], start);
  expect(schedule.due(start + CATALOG_RETRY_MAX_MS)).toEqual([]);
});
