import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOG_DISCOVERY_TIMEOUT_MS } from "#src/code-agent/catalog-discovery";
import { discoverCodexCatalog } from "#src/code-agent/codex/catalog";
import { CATALOG_DISCOVERY_BUDGET_MS } from "./catalog-discovery-budget";

/** Fast-mode reporting from Codex's catalog: live `model/list` (camelCase) and the cache fallback
 * (snake_case). A model with no tier field at all reports no `supportsFastMode`, so an older
 * Codex stays "unknown" rather than "no". */
const fixture = new URL("./fixtures/codex-app-server.ts", import.meta.url).pathname;

function liveCatalog(command: string[]) {
  return discoverCodexCatalog(
    [process.execPath, ...command],
    process.cwd(),
    { PATH: Bun.env.PATH },
    CATALOG_DISCOVERY_TIMEOUT_MS,
  );
}

test(
  "a live Codex model with a Fast service tier reports supportsFastMode",
  async () => {
    const catalog = await liveCatalog([fixture]);
    expect(catalog?.models.find((model) => model.id === "gpt-5.6-sol")?.supportsFastMode).toBe(
      true,
    );
  },
  CATALOG_DISCOVERY_BUDGET_MS,
);

test(
  "live Codex models map service tiers and speed tiers to supportsFastMode",
  async () => {
    const catalog = await liveCatalog([fixture, "catalog-speed-tiers"]);
    const models = new Map(catalog?.models.map((model) => [model.id, model]));
    expect(models.get("tier-service")?.supportsFastMode).toBe(true);
    expect(models.get("tier-speed")?.supportsFastMode).toBe(true);
    expect(models.get("no-fast")?.supportsFastMode).toBe(false);
    expect(models.get("other-tier")?.supportsFastMode).toBe(false);
    expect(models.get("legacy")).toBeDefined();
    expect(models.get("legacy")).not.toHaveProperty("supportsFastMode");
  },
  CATALOG_DISCOVERY_BUDGET_MS,
);

test(
  "the models_cache.json fallback maps service tiers and speed tiers the same way",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "codex-fast-cache-"));
    try {
      await Bun.write(
        join(home, ".codex", "models_cache.json"),
        JSON.stringify({
          models: [
            {
              slug: "cache-service",
              service_tiers: [{ id: "priority", name: "Fast" }],
            },
            { slug: "cache-speed", additional_speed_tiers: ["fast"] },
            { slug: "cache-no-fast", service_tiers: [], additional_speed_tiers: [] },
            { slug: "cache-other-tier", service_tiers: [{ id: "flex", name: "Flex" }] },
            { slug: "cache-legacy" },
          ],
        }),
      );
      const catalog = await discoverCodexCatalog(
        [process.execPath, fixture, "catalog-error"],
        process.cwd(),
        { HOME: home, PATH: Bun.env.PATH },
        CATALOG_DISCOVERY_TIMEOUT_MS,
      );
      const models = new Map(catalog?.models.map((model) => [model.id, model]));
      expect(models.get("cache-service")?.supportsFastMode).toBe(true);
      expect(models.get("cache-speed")?.supportsFastMode).toBe(true);
      expect(models.get("cache-no-fast")?.supportsFastMode).toBe(false);
      expect(models.get("cache-other-tier")?.supportsFastMode).toBe(false);
      expect(models.get("cache-legacy")).toBeDefined();
      expect(models.get("cache-legacy")).not.toHaveProperty("supportsFastMode");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
  CATALOG_DISCOVERY_BUDGET_MS,
);
