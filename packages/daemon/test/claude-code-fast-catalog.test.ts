import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_CODE_CATALOG_ARGUMENTS,
  claudeStaticCatalog,
  discoverClaudeCodeCatalog,
} from "#src/code-agent/claude-code/catalog";
import { CATALOG_DISCOVERY_TIMEOUT_MS } from "#src/code-agent/catalog-discovery";
import {
  discoverCodeAgentInventory,
  loadCachedCodeAgentCatalogs,
} from "#src/code-agent/runtime-inventory";
import { readInventoryCache } from "#src/code-agent/runtime-inventory-cache";
import {
  CATALOG_DISCOVERY_BUDGET_MS,
  SHORT_CATALOG_DISCOVERY_TIMEOUT_MS,
  spawnedCatalogDiscoveryBudgetMs,
} from "./catalog-discovery-budget";
import { probeFor } from "./fixtures/runtime-probe";

/** Claude Code's `list_models` answer decides each static model's `supportsFastMode`; the static
 * catalog keeps the model set. A failed or silent answer leaves every model's Fast support unknown. */
const fixture = new URL("./fixtures/claude-list-models.ts", import.meta.url).pathname;
const CLAUDE_VERSION = "2.1.306";
const environment = { HOME: "/fixture/home", PATH: "", PI_OFFLINE: "1" };

function claudeCommand(...modes: string[]): string[] {
  return [process.execPath, fixture, ...CLAUDE_CODE_CATALOG_ARGUMENTS, ...modes];
}

function fastFlags(models: Array<{ id: string; supportsFastMode?: boolean }>) {
  return new Map(models.map((model) => [model.id, model.supportsFastMode]));
}

test(
  "Claude Code's list_models marks each static model Fast-capable only where it lists Fast mode",
  async () => {
    const catalog = await discoverClaudeCodeCatalog(
      claudeCommand(),
      process.cwd(),
      { PATH: Bun.env.PATH },
      CATALOG_DISCOVERY_TIMEOUT_MS,
      CLAUDE_VERSION,
    );
    if (!catalog) throw new Error("expected a catalog from the listing fixture");
    const flags = fastFlags(catalog.models);
    expect(flags.get("opus")).toBe(true);
    // Reached through the listed `resolvedModel` of the `default` and `opus` entries.
    expect(flags.get("claude-opus-5-5")).toBe(true);
    expect(flags.get("claude-opus-5")).toBe(true);
    expect(flags.get("claude-opus-4-8")).toBe(true);
    expect(flags.get("sonnet")).toBe(false);
    expect(flags.get("claude-opus-4-6")).toBe(false);
    expect(catalog.models.map((model) => model.id)).toEqual(
      claudeStaticCatalog(CLAUDE_VERSION).models.map((model) => model.id),
    );
  },
  CATALOG_DISCOVERY_BUDGET_MS,
);

test(
  "a failed list_models answer yields no catalog, so the caller keeps the static one",
  async () => {
    const catalog = await discoverClaudeCodeCatalog(
      claudeCommand("list-models-error"),
      process.cwd(),
      { PATH: Bun.env.PATH },
      CATALOG_DISCOVERY_TIMEOUT_MS,
      CLAUDE_VERSION,
    );
    expect(catalog).toBeUndefined();
  },
  CATALOG_DISCOVERY_BUDGET_MS,
);

test(
  "a silent Claude Code yields no catalog when its wait times out",
  async () => {
    const catalog = await discoverClaudeCodeCatalog(
      claudeCommand("list-models-silent"),
      process.cwd(),
      { PATH: Bun.env.PATH },
      SHORT_CATALOG_DISCOVERY_TIMEOUT_MS,
      CLAUDE_VERSION,
    );
    expect(catalog).toBeUndefined();
  },
  spawnedCatalogDiscoveryBudgetMs(SHORT_CATALOG_DISCOVERY_TIMEOUT_MS),
);

/** A wait long enough that a discovery still waiting on it would fail the elapsed assertion. */
const EXIT_TEST_TIMEOUT_MS = 20_000;

test(
  "a Claude Code that exits before answering ends the wait at once and yields no catalog",
  async () => {
    const startedAt = performance.now();
    const catalog = await discoverClaudeCodeCatalog(
      claudeCommand("list-models-exit"),
      process.cwd(),
      { PATH: Bun.env.PATH },
      EXIT_TEST_TIMEOUT_MS,
      CLAUDE_VERSION,
    );
    expect(performance.now() - startedAt).toBeLessThan(EXIT_TEST_TIMEOUT_MS / 2);
    expect(catalog).toBeUndefined();
  },
  spawnedCatalogDiscoveryBudgetMs(EXIT_TEST_TIMEOUT_MS),
);

test("the cached inventory includes the static Claude catalog when the cache is empty", async () => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), "coforge-claude-fast-cache-"));
  try {
    const { catalogs, needsRefresh } = await loadCachedCodeAgentCatalogs(
      [{ provider: "claude-code", version: CLAUDE_VERSION, displayName: "Claude Code" }],
      {
        probe: probeFor({ claude: { path: "/bin/claude", version: CLAUDE_VERSION } }),
        piModels: async () => [],
        environment,
        cacheDirectory,
      },
    );
    expect(needsRefresh).toBe(true);
    expect(catalogs.find((catalog) => catalog.provider === "claude-code")).toEqual(
      claudeStaticCatalog(CLAUDE_VERSION),
    );
  } finally {
    await rm(cacheDirectory, { recursive: true, force: true });
  }
});

test(
  "a live Claude Code list is cached with its executable and read back with Fast support",
  async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), "coforge-claude-fast-state-"));
    const binDirectory = await mkdtemp(join(tmpdir(), "coforge-claude-fast-bin-"));
    const claudePath = join(binDirectory, "claude");
    try {
      await Bun.write(claudePath, "#!/bin/sh\n");
      const probe = probeFor({
        claude: { path: claudePath, version: `${CLAUDE_VERSION} (Claude Code)\n` },
      });
      const inventory = await discoverCodeAgentInventory({
        probe,
        commands: { claude: claudeCommand() },
        environment,
        piModels: async () => [],
        cacheDirectory,
      });
      expect(
        fastFlags(
          inventory.catalogs.find((catalog) => catalog.provider === "claude-code")?.models ?? [],
        ).get("opus"),
      ).toBe(true);

      const { catalogs } = await loadCachedCodeAgentCatalogs(inventory.runtimes, {
        probe,
        piModels: async () => [],
        environment,
        cacheDirectory,
      });
      const cached = catalogs.find((catalog) => catalog.provider === "claude-code");
      expect(fastFlags(cached?.models ?? []).get("opus")).toBe(true);
      expect(fastFlags(cached?.models ?? []).get("sonnet")).toBe(false);
    } finally {
      await rm(cacheDirectory, { recursive: true, force: true });
      await rm(binDirectory, { recursive: true, force: true });
    }
  },
  CATALOG_DISCOVERY_BUDGET_MS,
);

test(
  "a failed Claude Code list is reported but not cached, so the next load refreshes it",
  async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), "coforge-claude-fast-state-"));
    const binDirectory = await mkdtemp(join(tmpdir(), "coforge-claude-fast-bin-"));
    const claudePath = join(binDirectory, "claude");
    try {
      await Bun.write(claudePath, "#!/bin/sh\n");
      const probe = probeFor({
        claude: { path: claudePath, version: `${CLAUDE_VERSION} (Claude Code)\n` },
      });
      const inventory = await discoverCodeAgentInventory({
        probe,
        commands: { claude: claudeCommand("list-models-error") },
        environment,
        piModels: async () => [],
        cacheDirectory,
      });
      expect(inventory.catalogs.find((catalog) => catalog.provider === "claude-code")).toEqual(
        claudeStaticCatalog(CLAUDE_VERSION),
      );

      expect((await readInventoryCache(cacheDirectory))["claude-code"]?.catalog).toBeUndefined();
      const { catalogs, needsRefresh } = await loadCachedCodeAgentCatalogs(inventory.runtimes, {
        probe,
        piModels: async () => [],
        environment,
        cacheDirectory,
      });
      expect(needsRefresh).toBe(true);
      expect(catalogs.find((catalog) => catalog.provider === "claude-code")).toEqual(
        claudeStaticCatalog(CLAUDE_VERSION),
      );
    } finally {
      await rm(cacheDirectory, { recursive: true, force: true });
      await rm(binDirectory, { recursive: true, force: true });
    }
  },
  CATALOG_DISCOVERY_BUDGET_MS,
);
