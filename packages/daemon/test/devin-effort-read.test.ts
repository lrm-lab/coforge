import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DevinEffortRead } from "@lrm/coforge-anvil/devin";
import { CATALOG_CACHE_TTL_MS } from "#src/code-agent/runtime-inventory-cache";
import { readDevinEffortsForCatalog } from "#src/code-agent/devin/effort-read";

const ready = (efforts: string[]): DevinEffortRead => ({ status: "ready", efforts });
const failed: DevinEffortRead = { status: "failed", code: "unavailable" };

async function directory() {
  return mkdtemp(join(tmpdir(), "daemon-devin-effort-"));
}

test("Devin efforts cache by CLI version and model; a failed model stays unread", async () => {
  const stateDirectory = await directory();
  let now = 10_000;
  let liveCalls = 0;
  const live = async (modelIds: readonly string[]) => {
    liveCalls += 1;
    return new Map(
      modelIds.map((modelId) => [modelId, modelId === "broken" ? failed : ready(["high", "max"])]),
    );
  };
  const read = (modelIds: string[], version = "3000.11.228") =>
    readDevinEffortsForCatalog({
      modelIds,
      stateDirectory,
      version,
      now: () => now,
      live,
    });
  try {
    const first = await read(["swe-2-high", "broken"]);
    expect(first.complete).toBe(false);
    expect(first.efforts.get("swe-2-high")).toEqual(["high", "max"]);
    expect(liveCalls).toBe(1);
    // The success is cached; only the failure re-reads, and it still withholds.
    const second = await read(["swe-2-high", "broken"]);
    expect(second.complete).toBe(false);
    expect(liveCalls).toBe(2);
    // A round where every model resolves publishes.
    const third = await read(["swe-2-high", "gemini-3-5-flash-medium"]);
    expect(third.complete).toBe(true);
    expect(liveCalls).toBe(3);
    // Both now cached: another round answers without a process.
    const fourth = await read(["swe-2-high", "gemini-3-5-flash-medium"]);
    expect(fourth.complete).toBe(true);
    expect(liveCalls).toBe(3);
    // A new CLI version ignores the file.
    const fifth = await read(["swe-2-high"], "3000.12.0");
    expect(fifth.complete).toBe(true);
    expect(liveCalls).toBe(4);
    // TTL expiry re-reads.
    now += CATALOG_CACHE_TTL_MS + 1;
    const sixth = await read(["swe-2-high"], "3000.12.0");
    expect(sixth.complete).toBe(true);
    expect(liveCalls).toBe(5);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("the Devin catalog publishes fast and reports again once efforts resolve", async () => {
  const stateDirectory = await directory();
  const catalog = {
    provider: "devin" as const,
    models: [
      {
        id: "swe-2-high",
        displayName: "SWE-2",
        description: "",
        modelProvider: "devin",
        reasoningEfforts: [] as string[],
        defaultReasoning: "",
        recommended: false,
      },
    ],
  };
  const updates: { catalogs?: { models?: { id: string; reasoningEfforts: string[] }[] }[] }[] = [];
  const replies: {
    results?: {
      catalog?: { models?: { id: string; reasoningEfforts: string[] }[] };
    }[];
  }[] = [];
  const transport = {
    updateCodeAgents: async (report: (typeof updates)[number]) => {
      updates.push(report);
    },
    sendProviderModelRefreshResult: async (reply: (typeof replies)[number]) => {
      replies.push(reply);
    },
  };
  const { CodeAgentInventorySync } = await import("#src/daemon-runtime/code-agent-inventory-sync");
  const sync = new CodeAgentInventorySync(
    {
      runtimes: async () => [{ provider: "devin", version: "3000.11.228", displayName: "Devin" }],
      cachedCatalogs: async () => ({ catalogs: [], needsRefresh: false }),
      catalogs: async () => ({ catalogs: [catalog], failures: [] }),
      stateDirectory,
    },
    { workspaceId: "workspace-a", computerId: "computer-a" },
    () => true,
    undefined,
    async () => ({
      complete: true,
      efforts: new Map([["swe-2-high", ["medium", "high", "max"]]]),
    }),
  );
  try {
    await sync.refreshModels(
      {
        protocolMajor: 1,
        requestId: "refresh-1",
        provider: "devin",
        workspaceId: "workspace-a",
        computerId: "computer-a",
      },
      transport as never,
    );
    expect(updates).toHaveLength(2);
    expect(updates.at(0)?.catalogs?.[0]?.models?.[0]?.reasoningEfforts).toEqual([]);
    expect(updates.at(1)?.catalogs?.[0]?.models?.[0]?.reasoningEfforts).toEqual([
      "medium",
      "high",
      "max",
    ]);
    expect(replies.at(0)?.results?.[0]?.catalog?.models?.[0]?.reasoningEfforts).toEqual([
      "medium",
      "high",
      "max",
    ]);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("an unresolved Devin effort read does not republish", async () => {
  const stateDirectory = await directory();
  const updates: unknown[] = [];
  const transport = {
    updateCodeAgents: async (report: unknown) => {
      updates.push(report);
    },
    sendProviderModelRefreshResult: async () => {},
  };
  const { CodeAgentInventorySync } = await import("#src/daemon-runtime/code-agent-inventory-sync");
  const sync = new CodeAgentInventorySync(
    {
      runtimes: async () => [{ provider: "devin", version: "3000.11.228", displayName: "Devin" }],
      cachedCatalogs: async () => ({ catalogs: [], needsRefresh: false }),
      catalogs: async () => ({
        catalogs: [
          {
            provider: "devin",
            models: [
              {
                id: "swe-2-high",
                displayName: "SWE-2",
                description: "",
                modelProvider: "devin",
                reasoningEfforts: [],
                defaultReasoning: "",
                recommended: false,
              },
            ],
          },
        ],
        failures: [],
      }),
      stateDirectory,
    },
    { workspaceId: "workspace-a", computerId: "computer-a" },
    () => true,
    undefined,
    async () => ({ complete: false, efforts: new Map() }),
  );
  try {
    await sync.refreshModels(
      {
        protocolMajor: 1,
        requestId: "refresh-2",
        provider: "devin",
        workspaceId: "workspace-a",
        computerId: "computer-a",
      },
      transport as never,
    );
    expect(updates).toHaveLength(1);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("a sweep that changes nothing does not republish", async () => {
  const stateDirectory = await directory();
  const updates: unknown[] = [];
  const transport = {
    updateCodeAgents: async (report: unknown) => {
      updates.push(report);
    },
    sendProviderModelRefreshResult: async () => {},
  };
  const { CodeAgentInventorySync } = await import("#src/daemon-runtime/code-agent-inventory-sync");
  const sync = new CodeAgentInventorySync(
    {
      runtimes: async () => [{ provider: "devin", version: "3000.11.228", displayName: "Devin" }],
      cachedCatalogs: async () => ({ catalogs: [], needsRefresh: false }),
      catalogs: async () => ({
        catalogs: [
          {
            provider: "devin",
            models: [
              {
                id: "swe-2-high",
                displayName: "SWE-2",
                description: "",
                modelProvider: "devin",
                reasoningEfforts: ["medium", "high", "max"],
                defaultReasoning: "",
                recommended: false,
              },
            ],
          },
        ],
        failures: [],
      }),
      stateDirectory,
    },
    { workspaceId: "workspace-a", computerId: "computer-a" },
    () => true,
    undefined,
    async () => ({
      complete: true,
      efforts: new Map([["swe-2-high", ["medium", "high", "max"]]]),
    }),
  );
  try {
    await sync.refreshModels(
      {
        protocolMajor: 1,
        requestId: "refresh-3",
        provider: "devin",
        workspaceId: "workspace-a",
        computerId: "computer-a",
      },
      transport as never,
    );
    expect(updates).toHaveLength(1);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("cachedDevinEfforts answers only fresh same-version entries", async () => {
  const stateDirectory = await directory();
  const { cachedDevinEfforts, readDevinEffortsForCatalog } =
    await import("#src/code-agent/devin/effort-read");
  let now = 10_000;
  const live = async (modelIds: readonly string[]) =>
    new Map(modelIds.map((modelId) => [modelId, ready(["high"])]));
  try {
    await readDevinEffortsForCatalog({
      modelIds: ["swe-2-high"],
      stateDirectory,
      version: "3000.11.228",
      now: () => now,
      live,
    });
    expect(await cachedDevinEfforts(stateDirectory, "3000.11.228", ["swe-2-high"], now)).toEqual(
      new Map([["swe-2-high", ["high"]]]),
    );
    expect(await cachedDevinEfforts(stateDirectory, "3000.12.0", ["swe-2-high"], now)).toEqual(
      new Map(),
    );
    now += CATALOG_CACHE_TTL_MS + 1;
    expect(await cachedDevinEfforts(stateDirectory, "3000.11.228", ["swe-2-high"], now)).toEqual(
      new Map(),
    );
    expect(await cachedDevinEfforts(undefined, "3000.11.228", ["swe-2-high"], now)).toEqual(
      new Map(),
    );
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});
