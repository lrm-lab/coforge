import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenCodeEffortRead } from "@lrm/coforge-anvil/opencode";
import { CATALOG_CACHE_TTL_MS } from "#src/code-agent/runtime-inventory-cache";
import { readOpenCodeEffortsForCatalog } from "#src/code-agent/opencode/effort-read";

const ready = (efforts: string[]): OpenCodeEffortRead => ({ status: "ready", efforts });
const failed: OpenCodeEffortRead = { status: "failed", code: "unavailable" };

async function directory() {
  return mkdtemp(join(tmpdir(), "daemon-opencode-effort-"));
}

test("OpenCode efforts cache by CLI version and model; a failed model stays unread", async () => {
  const stateDirectory = await directory();
  let now = 10_000;
  let liveCalls = 0;
  const live = async (modelIds: readonly string[]) => {
    liveCalls += 1;
    return new Map(
      modelIds.map((modelId) => [modelId, modelId === "broken" ? failed : ready(["low", "high"])]),
    );
  };
  const read = (modelIds: string[], version = "2.1.0") =>
    readOpenCodeEffortsForCatalog({
      modelIds,
      stateDirectory,
      version,
      now: () => now,
      live,
    });
  try {
    const first = await read(["opencode/model-a", "broken"]);
    expect(first.complete).toBe(false);
    expect(first.efforts.get("opencode/model-a")).toEqual(["low", "high"]);
    expect(liveCalls).toBe(1);
    // The success is cached; only the failure re-reads, and it still withholds.
    const second = await read(["opencode/model-a", "broken"]);
    expect(second.complete).toBe(false);
    expect(liveCalls).toBe(2);
    // A round where every model resolves publishes.
    const third = await read(["opencode/model-a", "opencode/model-b"]);
    expect(third.complete).toBe(true);
    expect(liveCalls).toBe(3);
    // Both now cached: another round answers without a process.
    const fourth = await read(["opencode/model-a", "opencode/model-b"]);
    expect(fourth.complete).toBe(true);
    expect(liveCalls).toBe(3);
    // A new CLI version ignores the file.
    const fifth = await read(["opencode/model-a"], "2.2.0");
    expect(fifth.complete).toBe(true);
    expect(liveCalls).toBe(4);
    // TTL expiry re-reads.
    now += CATALOG_CACHE_TTL_MS + 1;
    const sixth = await read(["opencode/model-a"], "2.2.0");
    expect(sixth.complete).toBe(true);
    expect(liveCalls).toBe(5);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("OpenCode catalog discovery fills efforts from the cache alone", async () => {
  const stateDirectory = await directory();
  const live = async () => new Map([["opencode/model-a", ready(["minimal", "high"])]]);
  try {
    // One live read seeds the cache; the next catalog fill needs no process.
    const seeded = await readOpenCodeEffortsForCatalog({
      modelIds: ["opencode/model-a"],
      stateDirectory,
      version: "2.1.0",
      live,
    });
    expect(seeded.complete).toBe(true);
    const { openCodeCatalogWithCachedEfforts } =
      await import("#src/code-agent/opencode/effort-read");
    const { catalog, complete } = await openCodeCatalogWithCachedEfforts(
      {
        provider: "opencode",
        models: [
          {
            id: "opencode/model-a",
            displayName: "A",
            description: "",
            modelProvider: "",
            reasoningEfforts: [],
            defaultReasoning: "",
            recommended: false,
          },
        ],
      },
      stateDirectory,
      "2.1.0",
    );
    expect(complete).toBe(true);
    expect(catalog.models[0]?.reasoningEfforts).toEqual(["minimal", "high"]);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("the OpenCode catalog reports again once its effort sweep resolves", async () => {
  const stateDirectory = await directory();
  const catalog = {
    provider: "opencode" as const,
    models: [
      {
        id: "opencode/model-a",
        displayName: "A",
        description: "",
        modelProvider: "opencode",
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
      runtimes: async () => [{ provider: "opencode", version: "2.1.0", displayName: "OpenCode" }],
      cachedCatalogs: async () => ({ catalogs: [], needsRefresh: false }),
      catalogs: async () => ({ catalogs: [catalog], failures: [] }),
      stateDirectory,
    },
    { workspaceId: "workspace-a", computerId: "computer-a" },
    () => true,
    undefined,
    undefined,
    async () => ({
      complete: true,
      efforts: new Map([["opencode/model-a", ["minimal", "high"]]]),
    }),
  );
  try {
    await sync.refreshModels(
      {
        protocolMajor: 1,
        requestId: "refresh-oc-1",
        provider: "opencode",
        workspaceId: "workspace-a",
        computerId: "computer-a",
      },
      transport as never,
    );
    expect(updates).toHaveLength(2);
    expect(updates.at(0)?.catalogs?.[0]?.models?.[0]?.reasoningEfforts).toEqual([]);
    expect(updates.at(1)?.catalogs?.[0]?.models?.[0]?.reasoningEfforts).toEqual([
      "minimal",
      "high",
    ]);
    expect(replies.at(0)?.results?.[0]?.catalog?.models?.[0]?.reasoningEfforts).toEqual([
      "minimal",
      "high",
    ]);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});
