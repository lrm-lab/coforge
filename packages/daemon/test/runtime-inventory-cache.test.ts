import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverCodeAgentInventory } from "#src/code-agent/runtime-inventory";
import {
  SHORT_CATALOG_DISCOVERY_TIMEOUT_MS,
  spawnedCatalogDiscoveryBudgetMs,
} from "./catalog-discovery-budget";

async function discover(
  mode: string,
  cache?: string,
  force = false,
  catalogDiscoveryTimeoutMs?: number,
) {
  const home = await mkdtemp(join(tmpdir(), "codex-catalog-"));
  try {
    if (cache !== undefined) await Bun.write(join(home, ".codex", "models_cache.json"), cache);
    return await discoverCodeAgentInventory({
      force,
      environment: { HOME: home, PATH: Bun.env.PATH },
      probe: {
        which: (name) => (name === "codex" ? "/fixture/codex" : undefined),
        spawn: () => ({ stdout: new Blob(["0.153.4"]).stream(), exited: Promise.resolve(0) }),
      },
      commands: {
        codex: [
          process.execPath,
          new URL("./fixtures/codex-app-server.ts", import.meta.url).pathname,
          mode,
        ],
      },
      piModels: async () => [],
      catalogDiscoveryTimeoutMs,
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
const cache = JSON.stringify({
  models: [
    {
      slug: "cached-model",
      display_name: "Cached model",
      visibility: "list",
      supported_in_api: true,
      supported_reasoning_levels: [{ effort: "high" }],
      default_reasoning_level: "high",
    },
    { slug: "hidden", visibility: "hide" },
    { slug: "unsupported", supported_in_api: false },
    { display_name: "invalid" },
  ],
});

test(
  "falls back to the visible cached Codex models after the catalog deadline",
  async () => {
    const inventory = await discover(
      "catalog-timeout",
      cache,
      false,
      SHORT_CATALOG_DISCOVERY_TIMEOUT_MS,
    );
    expect(inventory.catalogs.find((catalog) => catalog.provider === "codex")?.models).toEqual([
      {
        id: "cached-model",
        displayName: "Cached model",
        description: "",
        modelProvider: "",
        reasoningEfforts: ["high"],
        defaultReasoning: "high",
        recommended: false,
      },
    ]);
  },
  spawnedCatalogDiscoveryBudgetMs(SHORT_CATALOG_DISCOVERY_TIMEOUT_MS),
);

test("prefers the live Codex catalog over cached models", async () => {
  const inventory = await discover("", cache);
  expect(
    inventory.catalogs
      .find((catalog) => catalog.provider === "codex")
      ?.models.map((model) => model.id),
  ).toEqual(["gpt-5.6-sol"]);
});

for (const unavailable of [
  undefined,
  "invalid json",
  "{}",
  '{"models":[{"slug":"hidden","visibility":"hide"}]}',
]) {
  test(`omits the Codex catalog when live discovery fails and cache is unusable: ${unavailable}`, async () => {
    const inventory = await discover("catalog-error", unavailable);
    expect(inventory.catalogs.some((catalog) => catalog.provider === "codex")).toBe(false);
  });
}

test("uses cached models when the live provider returns an error", async () => {
  const inventory = await discover("catalog-error", cache);
  expect(inventory.catalogs.find((catalog) => catalog.provider === "codex")?.models[0]?.id).toBe(
    "cached-model",
  );
});

test("a forced discovery omits Codex when its live probe fails instead of returning cache", async () => {
  const inventory = await discover("catalog-error", cache, true);
  expect(inventory.catalogs.some((catalog) => catalog.provider === "codex")).toBe(false);
});
