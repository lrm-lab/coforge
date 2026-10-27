import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverCodeAgentCatalogs,
  loadCachedCodeAgentCatalogs,
} from "#src/code-agent/runtime-inventory";
import type { ExternalCodeAgentProbe } from "#src/code-agent/runtime-executable";
import { OPENCODE_DISCOVERY_BUDGET_MS } from "./catalog-discovery-budget";
import { anvilRuntimeFixtures } from "./fixtures/anvil-runtime";

const OPENCODE_FIXTURE = anvilRuntimeFixtures.opencode;

describe("Code Agent catalog cache", () => {
  test("caches the Pi model catalog keyed by models.json and auth.json, and invalidates on change", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "coforge-probe-cache-state-"));
    const home = await mkdtemp(join(tmpdir(), "coforge-probe-cache-pi-"));
    const agentDir = join(home, ".pi", "agent");
    await mkdir(agentDir, { recursive: true });
    const writeModels = (id: string) =>
      Bun.write(
        join(agentDir, "models.json"),
        JSON.stringify({
          providers: {
            fixture: {
              baseUrl: "http://localhost.invalid/v1",
              apiKey: "local",
              models: [{ id, name: id, api: "openai-completions" }],
            },
          },
        }),
      );
    await writeModels("host-model-1");
    // The real Pi SDK creates auth.json on discovery; the fake below does not, and the cache key
    // needs both files to exist.
    await Bun.write(join(agentDir, "auth.json"), "{}");
    const environment = { HOME: home, PATH: "", PI_OFFLINE: "1" };
    const runtimes = [{ provider: "pi" as const, version: "0.0.0", displayName: "Pi" }];
    const probe: ExternalCodeAgentProbe = {
      which: () => undefined,
      spawn: () => ({ stdout: new Blob([]).stream(), exited: Promise.resolve(0) }),
    };
    try {
      await discoverCodeAgentCatalogs(runtimes, {
        cwd: home,
        environment,
        probe,
        // Stands in for the Pi SDK reading models.json; this case is about the cache key.
        piModels: async () => [{ id: "host-model-1", provider: "fixture" }] as never,
        cacheDirectory: stateDirectory,
      });

      const cached = await loadCachedCodeAgentCatalogs(runtimes, {
        cwd: home,
        environment,
        probe,
        piModels: async () => [],
        cacheDirectory: stateDirectory,
      });
      expect(cached.needsRefresh).toBe(false);
      expect(cached.catalogs.find((catalog) => catalog.provider === "pi")?.models).toContainEqual(
        expect.objectContaining({ id: "host-model-1" }),
      );

      // Changing models.json invalidates the cached key.
      await writeModels("host-model-2");
      const stale = await loadCachedCodeAgentCatalogs(runtimes, {
        cwd: home,
        environment,
        probe,
        piModels: async () => [],
        cacheDirectory: stateDirectory,
      });
      expect(stale.needsRefresh).toBe(true);
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test("loadCachedCodeAgentCatalogs never spawns and needs a refresh when nothing is cached yet", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "coforge-probe-cache-state-"));
    try {
      const result = await loadCachedCodeAgentCatalogs(
        [{ provider: "codex", version: "0.151.0", displayName: "Codex" }],
        {
          probe: {
            which: () => "/bin/codex",
            spawn: () => ({ stdout: new Blob([]).stream(), exited: Promise.resolve(0) }),
          },
          piModels: async () => [],
          cacheDirectory: stateDirectory,
        },
      );
      expect(result.needsRefresh).toBe(true);
      // CoForge's static catalog is always included; nothing dynamic is available yet.
      expect(result.catalogs.map((catalog) => catalog.provider)).toEqual(["coforge"]);
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });
});

test(
  "the live refresh discovers the OpenCode catalog too, not just its runtime",
  async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "coforge-opencode-catalog-state-"));
    // The refresh resolves the provider's executable through `probe.which`; point it at a path that
    // exists (the injected `commands.opencode` is what actually runs) so the branch is taken.
    const binDirectory = await mkdtemp(join(tmpdir(), "coforge-opencode-catalog-bin-"));
    const opencodePath = join(binDirectory, "opencode");
    await Bun.write(opencodePath, "#!/bin/sh\nexit 0\n");
    try {
      const probe: ExternalCodeAgentProbe = {
        which: (name) => (name === "opencode" ? opencodePath : undefined),
        spawn: () => ({
          stdout: new Blob(["opencode v2.0.30"]).stream(),
          exited: Promise.resolve(0),
        }),
      };
      const catalogs = await discoverCodeAgentCatalogs(
        [{ provider: "opencode" as const, version: "2.0.30", displayName: "OpenCode" }],
        {
          cwd: process.cwd(),
          // A fixture home keeps the Pi catalog, discovered in the same pass, off the developer's
          // real Pi configuration; that discovery can run for seconds and was most of this test's
          // time.
          environment: { PATH: process.env.PATH, HOME: "/fixture/home" },
          commands: { opencode: [process.execPath, OPENCODE_FIXTURE, "models"] },
          probe,
          piModels: async () => [],
          cacheDirectory: stateDirectory,
        },
      );

      const opencode = catalogs.find((catalog) => catalog.provider === "opencode");
      expect(opencode?.models.map((model) => model.id)).toEqual([
        "opencode/big-pickle",
        "aiberm/gpt-5.6-luna",
      ]);
      expect(opencode?.models[0]?.reasoningEfforts).toEqual(["low", "medium", "high"]);
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
      await rm(binDirectory, { recursive: true, force: true });
    }
  },
  OPENCODE_DISCOVERY_BUDGET_MS,
);
