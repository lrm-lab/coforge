import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverCodexCatalog } from "#src/code-agent/codex/catalog";
import {
  SHORT_CATALOG_DISCOVERY_TIMEOUT_MS,
  spawnedCatalogDiscoveryBudgetMs,
} from "./catalog-discovery-budget";

const fixture = new URL("./fixtures/codex-app-server.ts", import.meta.url).href;
const cached = (slug: string) => JSON.stringify({ models: [{ slug }] });
const cases: ReadonlyArray<{
  name: string;
  configured?: string;
  noHome?: boolean;
  userProfile?: boolean;
  files: ReadonlyArray<readonly [string, string]>;
  expected: string | undefined;
  live?: boolean;
  force?: boolean;
}> = [
  {
    name: "uses the configured absolute root instead of the default home",
    configured: "/custom",
    files: [["custom/models_cache.json", cached("custom")]],
    expected: "custom",
  },
  {
    name: "resolves a relative CODEX_HOME from the child working directory",
    configured: "custom",
    files: [["custom/models_cache.json", cached("relative")]],
    expected: "relative",
  },
  {
    name: "prefers the configured root over its nested state directory",
    configured: "/custom",
    files: [
      ["custom/models_cache.json", cached("direct")],
      ["custom/.codex/models_cache.json", cached("nested")],
    ],
    expected: "direct",
  },
  ...[undefined, "invalid json", "{}", '{"models":[{"slug":"hidden","visibility":"hide"}]}'].map(
    (unusable) => ({
      name: "tries the nested state directory after an unusable cache: " + unusable,
      configured: "/custom",
      files: [
        ...(unusable === undefined ? [] : [["custom/models_cache.json", unusable] as const]),
        ["custom/.codex/models_cache.json", cached("nested")] as const,
      ],
      expected: "nested",
    }),
  ),
  {
    name: "does not fall back to a different home when the configured root is missing",
    configured: "/missing",
    files: [],
    expected: undefined,
  },
  {
    name: "can read a configured root without HOME or USERPROFILE",
    configured: "/custom",
    noHome: true,
    files: [["custom/models_cache.json", cached("custom")]],
    expected: "custom",
  },
  ...[undefined, "", "   "].map((configured) => ({
    name:
      "uses the default .codex directory without a nonblank override: " +
      JSON.stringify(configured),
    configured,
    files: [],
    expected: "default",
  })),
  {
    name: "uses USERPROFILE when HOME is absent",
    userProfile: true,
    files: [],
    expected: "default",
  },
  {
    name: "does not read the configured cache during a forced refresh",
    configured: "/custom",
    force: true,
    files: [["custom/models_cache.json", cached("custom")]],
    expected: undefined,
  },
  {
    name: "prefers live models over the configured cache",
    configured: "/custom",
    live: true,
    files: [["custom/models_cache.json", cached("custom")]],
    expected: "gpt-5.6-sol",
  },
];

for (const scenario of cases) {
  test(
    "Codex catalog " + scenario.name,
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "codex-catalog-home-"));
      try {
        const home = join(cwd, "home");
        const capture = join(cwd, "child-home");
        await Bun.write(join(home, ".codex", "models_cache.json"), cached("default"));
        for (const [path, data] of scenario.files) await Bun.write(join(cwd, path), data);
        const configured = scenario.configured?.startsWith("/")
          ? join(cwd, scenario.configured.slice(1))
          : scenario.configured;
        const environment = {
          ...(scenario.noHome ? {} : scenario.userProfile ? { USERPROFILE: home } : { HOME: home }),
          ...(configured === undefined ? {} : { CODEX_HOME: configured }),
        };
        const catalog = await discoverCodexCatalog(
          [
            process.execPath,
            "-e",
            "await Bun.write(" +
              JSON.stringify(capture) +
              ', Bun.env.CODEX_HOME ?? ""); await import(' +
              JSON.stringify(fixture) +
              ");",
            ...(scenario.live ? [] : ["catalog-error"]),
          ],
          cwd,
          environment,
          SHORT_CATALOG_DISCOVERY_TIMEOUT_MS,
          scenario.force,
        );
        expect(catalog?.models.map((model) => model.id)).toEqual(
          scenario.expected === undefined ? undefined : [scenario.expected],
        );
        // Observe the real probe child's environment, not only the environment builder.
        expect(await Bun.file(capture).text()).toBe(configured ?? "");
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
    spawnedCatalogDiscoveryBudgetMs(SHORT_CATALOG_DISCOVERY_TIMEOUT_MS),
  );
}
