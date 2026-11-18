import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverCodeAgentInventory,
  loadCachedCodeAgentCatalogs,
} from "#src/code-agent/runtime-inventory";
import { claudeStaticCatalog } from "@lrm/coforge-anvil/claude-code";
import { FULL_EFFORTS, probeFor } from "./fixtures/runtime-probe";

describe("Claude Code model catalog minimum versions", () => {
  // https://code.claude.com/docs/en/model-config: Sonnet 5.5 requires Claude Code v2.1.284, Opus
  // 5.5 v2.1.280, Fable 5.2 v2.1.321, Fable 5.1 v2.1.257, Haiku 5.5 v2.1.293. The docs state no
  // minimum for the other pinned models.
  const ALIASES = ["opus", "fable", "sonnet", "haiku"];
  const PINNED_WITHOUT_MINIMUM = [
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-fable-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
  ];
  const FABLE_5_2 = "claude-fable-5-2";
  const FABLE_5_1 = "claude-fable-5-1";
  const OPUS_5_5 = "claude-opus-5-5";
  const SONNET_5_5 = "claude-sonnet-5-5";
  const HAIKU_5_5 = "claude-haiku-5-5";
  const cases: Array<{ version: string; listed: string[] }> = [
    { version: "2.1.0", listed: [] },
    { version: "2.1.256", listed: [] },
    { version: "2.1.257", listed: [FABLE_5_1] },
    { version: "2.1.279", listed: [FABLE_5_1] },
    { version: "2.1.280", listed: [FABLE_5_1, OPUS_5_5] },
    { version: "2.1.283", listed: [FABLE_5_1, OPUS_5_5] },
    { version: "2.1.284", listed: [FABLE_5_1, OPUS_5_5, SONNET_5_5] },
    { version: "2.1.292", listed: [FABLE_5_1, OPUS_5_5, SONNET_5_5] },
    { version: "2.1.293", listed: [FABLE_5_1, OPUS_5_5, SONNET_5_5, HAIKU_5_5] },
    { version: "2.1.320", listed: [FABLE_5_1, OPUS_5_5, SONNET_5_5, HAIKU_5_5] },
    { version: "2.1.321", listed: [FABLE_5_2, FABLE_5_1, OPUS_5_5, SONNET_5_5, HAIKU_5_5] },
    { version: "2.2.0", listed: [FABLE_5_2, FABLE_5_1, OPUS_5_5, SONNET_5_5, HAIKU_5_5] },
    { version: "3.0.0", listed: [FABLE_5_2, FABLE_5_1, OPUS_5_5, SONNET_5_5, HAIKU_5_5] },
  ];
  const ids = (catalog: { models: Array<{ id: string }> } | undefined) =>
    catalog?.models.map((model) => model.id) ?? [];
  const expectListed = (modelIds: string[], listed: string[]) => {
    expect(modelIds).toEqual(expect.arrayContaining([...ALIASES, ...PINNED_WITHOUT_MINIMUM]));
    for (const id of [FABLE_5_2, FABLE_5_1, OPUS_5_5, SONNET_5_5, HAIKU_5_5])
      expect(modelIds.includes(id)).toBe(listed.includes(id));
  };

  for (const { version, listed } of cases) {
    test(`the live inventory of Claude Code ${version} lists ${listed.length} of the 5 minimum-gated models`, async () => {
      const inventory = await discoverCodeAgentInventory({
        probe: probeFor({ claude: { path: "/bin/claude", version: `${version} (Claude Code)\n` } }),
        environment: { HOME: "/fixture/home", PATH: "", PI_OFFLINE: "1" },
        piModels: async () => [],
      });
      expect(inventory.runtimes).toContainEqual({
        provider: "claude-code",
        version,
        displayName: "Claude Code",
      });
      expectListed(
        ids(inventory.catalogs.find((catalog) => catalog.provider === "claude-code")),
        listed,
      );
    });

    test(`the cached inventory of Claude Code ${version} lists the same models`, async () => {
      const { catalogs } = await loadCachedCodeAgentCatalogs(
        [{ provider: "claude-code", version, displayName: "Claude Code" }],
        {
          probe: probeFor({}),
          piModels: async () => [],
          environment: { HOME: "/fixture/home", PATH: "" },
        },
      );
      expectListed(ids(catalogs.find((catalog) => catalog.provider === "claude-code")), listed);
    });
  }

  test("a version that is unknown or not a dotted number keeps the full list", () => {
    const full = [
      ...ALIASES,
      FABLE_5_2,
      FABLE_5_1,
      OPUS_5_5,
      SONNET_5_5,
      HAIKU_5_5,
      ...PINNED_WITHOUT_MINIMUM,
    ];
    for (const catalog of [
      claudeStaticCatalog(),
      claudeStaticCatalog(undefined),
      claudeStaticCatalog(""),
      claudeStaticCatalog("not-a-version"),
      // A pre-release suffix is not a dotted number, so the comparison declines to gate on it.
      claudeStaticCatalog("2.1.100-beta.1"),
    ])
      expect(ids(catalog).toSorted()).toEqual(full.toSorted());
  });

  test("a Claude Code upgrade re-reads the version through the probe cache and lists the new models", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "coforge-claude-catalog-state-"));
    const binDirectory = await mkdtemp(join(tmpdir(), "coforge-claude-catalog-bin-"));
    const claudePath = join(binDirectory, "claude");
    try {
      await Bun.write(claudePath, "#!/bin/sh\necho old\n");
      const installed = { claude: { path: claudePath, version: "2.1.100 (Claude Code)\n" } };
      const inventory = () =>
        discoverCodeAgentInventory({
          probe: probeFor(installed),
          environment: { HOME: "/fixture/home", PATH: "", PI_OFFLINE: "1" },
          piModels: async () => [],
          cacheDirectory: stateDirectory,
        });
      const claudeModelIds = async () =>
        ids((await inventory()).catalogs.find((catalog) => catalog.provider === "claude-code"));

      expectListed(await claudeModelIds(), []);

      // A new binary has a new size, so the cache key changes and the probe runs again.
      await Bun.write(claudePath, "#!/bin/sh\necho upgraded claude\n");
      installed.claude.version = "2.1.285 (Claude Code)\n";
      expectListed(await claudeModelIds(), [FABLE_5_1, OPUS_5_5, SONNET_5_5]);
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
      await rm(binDirectory, { recursive: true, force: true });
    }
  });

  test("upgrading Claude Code from 2.1.306 to 2.1.327 clears any stale cached catalog and lists Claude Fable 5.2", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "coforge-claude-catalog-state-"));
    const binDirectory = await mkdtemp(join(tmpdir(), "coforge-claude-catalog-bin-"));
    const claudePath = join(binDirectory, "claude");
    try {
      await Bun.write(claudePath, "#!/bin/sh\necho claude 2.1.306\n");
      const installed = { claude: { path: claudePath, version: "2.1.306 (Claude Code)\n" } };
      const inventory = () =>
        discoverCodeAgentInventory({
          probe: probeFor(installed),
          environment: { HOME: "/fixture/home", PATH: "", PI_OFFLINE: "1" },
          piModels: async () => [],
          cacheDirectory: stateDirectory,
        });
      const claudeModelIds = async () =>
        ids((await inventory()).catalogs.find((catalog) => catalog.provider === "claude-code"));

      expectListed(await claudeModelIds(), [FABLE_5_1, OPUS_5_5, SONNET_5_5, HAIKU_5_5]);

      const cacheFile = join(stateDirectory, "code-agent-inventory-cache.json");
      const cache = JSON.parse(await readFile(cacheFile, "utf8")) as Record<
        string,
        Record<string, unknown>
      >;
      cache["claude-code"] = {
        ...cache["claude-code"],
        catalog: { provider: "claude-code", models: [] },
      };
      await writeFile(cacheFile, JSON.stringify(cache));

      await Bun.write(claudePath, "#!/bin/sh\necho upgraded claude 2.1.327\n");
      installed.claude.version = "2.1.327 (Claude Code)\n";
      expectListed(await claudeModelIds(), [FABLE_5_2, FABLE_5_1, OPUS_5_5, SONNET_5_5, HAIKU_5_5]);

      const updatedCache = JSON.parse(await readFile(cacheFile, "utf8")) as Record<
        string,
        Record<string, unknown>
      >;
      expect(updatedCache["claude-code"]?.catalog).toBeUndefined();
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
      await rm(binDirectory, { recursive: true, force: true });
    }
  });

  test("the aliases are listed for every version, before the pinned models", () => {
    for (const { version } of cases)
      expect(ids(claudeStaticCatalog(version)).slice(0, 4)).toEqual(ALIASES);
  });
});

test("the Claude catalog gives every model but haiku the full effort list", () => {
  const efforts = Object.fromEntries(
    claudeStaticCatalog().models.map((model) => [model.id, model.reasoningEfforts]),
  );
  expect(efforts["opus"]).toEqual([...FULL_EFFORTS]);
  expect(efforts["fable"]).toEqual([...FULL_EFFORTS]);
  expect(efforts["sonnet"]).toEqual([...FULL_EFFORTS]);
  expect(efforts["haiku"]).toEqual([]);
});
