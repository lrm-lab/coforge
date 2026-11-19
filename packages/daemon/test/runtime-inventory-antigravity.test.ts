import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ANTIGRAVITY_ACP_MIN_VERSION,
  isAntigravityAcpVersionUnsupported,
} from "@lrm/coforge-anvil/antigravity";
import {
  discoverCodeAgentCatalogs,
  discoverCodeAgentInventory,
  loadCachedCodeAgentCatalogs,
} from "#src/code-agent/runtime-inventory";
import { discoverExternalCodeAgents } from "#src/code-agent/runtime-probe";
import {
  externalCodeAgent,
  resolveExternalCodeAgentExecutable,
  type ExternalCodeAgentProbe,
} from "#src/code-agent/runtime-executable";
import { cachedBelowFloor } from "#src/code-agent/runtime-version-floors";
import {
  ANTIGRAVITY_DISCOVERY_BUDGET_MS,
  CATALOG_DISCOVERY_BUDGET_MS,
} from "./catalog-discovery-budget";
import { anvilRuntimeFixtures } from "./fixtures/anvil-runtime";

import { captureDaemonLogs } from "./log-capture";

const PASS_BUDGET_MS = Math.max(CATALOG_DISCOVERY_BUDGET_MS, ANTIGRAVITY_DISCOVERY_BUDGET_MS);

const ACP_FIXTURE = anvilRuntimeFixtures.antigravityAcp;
const ACP_MODELS = JSON.stringify([
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "gemini-3.8-flash-high",
    options: [
      { value: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
      { value: "gemini-3.1-pro-high", name: "Gemini 3.1 Pro (High)" },
    ],
  },
]);

function agyProbe(versionOutput: string, path = "/bin/agy"): ExternalCodeAgentProbe {
  return {
    which: (name) => (name === "agy" ? path : undefined),
    spawn: () => ({
      stdout: new Blob([versionOutput]).stream(),
      exited: Promise.resolve(0),
    }),
  };
}

describe("Antigravity CLI version gate", () => {
  test("compares dotted numbers, so 1.10.0 is newer than 1.5.8 and an unreadable version never gates", () => {
    expect(ANTIGRAVITY_ACP_MIN_VERSION).toBe("1.5.8");
    expect(isAntigravityAcpVersionUnsupported("1.5.7")).toBe(true);
    expect(isAntigravityAcpVersionUnsupported("1.5.0")).toBe(true);
    expect(isAntigravityAcpVersionUnsupported("1.2.13")).toBe(true);
    expect(isAntigravityAcpVersionUnsupported("1.5.8")).toBe(false);
    expect(isAntigravityAcpVersionUnsupported("1.5.10")).toBe(false);
    expect(isAntigravityAcpVersionUnsupported("1.10.0")).toBe(false);
    expect(isAntigravityAcpVersionUnsupported("2.0.0")).toBe(false);
    expect(isAntigravityAcpVersionUnsupported("unknown")).toBe(false);
  });

  test("reports the runtime with the version `agy --version` prints", async () => {
    await expect(discoverExternalCodeAgents(agyProbe("1.5.10\n"))).resolves.toEqual([
      { provider: "antigravity", version: "1.5.10", displayName: "Antigravity CLI" },
    ]);
  });

  test("reads the version from the last token when a wrapper prints a line first", async () => {
    await expect(
      discoverExternalCodeAgents(agyProbe("agy wrapper: using profile default\n1.5.11\n")),
    ).resolves.toEqual([
      { provider: "antigravity", version: "1.5.11", displayName: "Antigravity CLI" },
    ]);
  });

  test("reports the runtime as unusable, and logs a warning, when the CLI is below the baseline", async () => {
    const { records } = await captureDaemonLogs(async () => {
      await expect(discoverExternalCodeAgents(agyProbe("1.5.7\n"))).resolves.toEqual([
        {
          provider: "antigravity",
          version: "1.5.7",
          displayName: "Antigravity CLI",
          unavailableCode: "version_unsupported",
        },
      ]);
    });
    const warning = records.find(
      (record) => record.properties.event === "code_agent_runtime:version_unsupported",
    );
    expect(warning?.properties).toMatchObject({
      provider: "antigravity",
      executable_name: "agy",
      version: "1.5.7",
      minimum_version: ANTIGRAVITY_ACP_MIN_VERSION,
      outcome: "unavailable",
    });
  });

  test("reports the runtime when the version output cannot be confidently parsed", async () => {
    await expect(discoverExternalCodeAgents(agyProbe("unknown\n"))).resolves.toEqual([
      { provider: "antigravity", version: "unknown", displayName: "Antigravity CLI" },
    ]);
  });

  test("evicts a cached Antigravity runtime below the ACP floor", () => {
    expect(
      cachedBelowFloor("antigravity", "agy", {
        provider: "antigravity",
        version: "1.5.7",
        displayName: "Antigravity CLI",
      }),
    ).toBe(true);
    expect(
      cachedBelowFloor("antigravity", "agy", {
        provider: "antigravity",
        version: "1.5.8",
        displayName: "Antigravity CLI",
      }),
    ).toBe(false);
  });

  test("discovers agy from ~/.local/bin on POSIX and %LOCALAPPDATA%/agy/bin on Windows when absent from PATH", async () => {
    const posixPath = "/home/tester/.local/bin/agy";
    const posixProbe: ExternalCodeAgentProbe = {
      which: () => undefined,
      exists: (candidate) => candidate === posixPath,
      spawn: () => ({ stdout: new Blob(["1.5.10\n"]).stream(), exited: Promise.resolve(0) }),
    };
    await expect(
      resolveExternalCodeAgentExecutable(
        externalCodeAgent.antigravity,
        posixProbe,
        "",
        { HOME: "/home/tester" },
        "linux",
      ),
    ).resolves.toBe(posixPath);

    const winPath = join("C:\\Users\\tester\\AppData\\Local", "agy", "bin", "agy.exe");
    const winProbe: ExternalCodeAgentProbe = {
      which: () => undefined,
      exists: (candidate) => candidate === winPath,
      spawn: () => ({ stdout: new Blob(["1.5.10\n"]).stream(), exited: Promise.resolve(0) }),
    };
    await expect(
      resolveExternalCodeAgentExecutable(
        externalCodeAgent.antigravity,
        winProbe,
        "",
        { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" },
        "win32",
      ),
    ).resolves.toBe(winPath);
  });
});

describe("Antigravity ACP model catalog in the inventory", () => {
  const environment = {
    HOME: "/fixture/home",
    PATH: "",
    PI_OFFLINE: "1",
    AGY_ACP_FIXTURE_CONFIG_OPTIONS: "",
  };

  test(
    "discovers the catalog of an installed runtime through `agy acp`",
    async () => {
      const inventory = await discoverCodeAgentInventory({
        probe: agyProbe("1.5.10\n"),
        commands: { antigravity: [process.execPath, ACP_FIXTURE] },
        environment: { ...environment, AGY_ACP_FIXTURE_CONFIG_OPTIONS: ACP_MODELS },
        piModels: async () => [],
      });

      expect(inventory.runtimes).toContainEqual({
        provider: "antigravity",
        version: "1.5.10",
        displayName: "Antigravity CLI",
      });
      const catalog = inventory.catalogs.find((entry) => entry.provider === "antigravity");
      expect(catalog?.models).toHaveLength(2);
      expect(catalog?.models[0]).toMatchObject({
        id: "gemini-3.8-flash-high",
        displayName: "Gemini 3.8 Flash (High)",
      });
    },
    PASS_BUDGET_MS,
  );

  test(
    "keeps the installed runtime when its catalog is unavailable",
    async () => {
      const inventory = await discoverCodeAgentInventory({
        probe: agyProbe("1.5.10\n"),
        commands: { antigravity: [process.execPath, "-e", "process.exit(1)"] },
        environment,
        piModels: async () => [],
      });

      expect(inventory.runtimes.some((runtime) => runtime.provider === "antigravity")).toBe(true);
      expect(inventory.catalogs.some((catalog) => catalog.provider === "antigravity")).toBe(false);
    },
    PASS_BUDGET_MS,
  );

  test(
    "does not spawn the catalog command once the runtime is gated out by version",
    async () => {
      const marker = join(
        tmpdir(),
        `coforge-antigravity-catalog-should-not-spawn-${crypto.randomUUID()}`,
      );
      try {
        const inventory = await discoverCodeAgentInventory({
          probe: agyProbe("1.5.7\n"),
          commands: {
            antigravity: [
              process.execPath,
              "-e",
              `require("fs").writeFileSync(${JSON.stringify(marker)}, "spawned")`,
            ],
          },
          environment,
          piModels: async () => [],
        });
        expect(
          inventory.runtimes.find((runtime) => runtime.provider === "antigravity"),
        ).toMatchObject({ unavailableCode: "version_unsupported" });
        expect(inventory.catalogs.some((catalog) => catalog.provider === "antigravity")).toBe(
          false,
        );
        expect(await Bun.file(marker).exists()).toBe(false);
      } finally {
        await Bun.file(marker)
          .delete()
          .catch(() => undefined);
      }
    },
    PASS_BUDGET_MS,
  );

  test(
    "caches the catalog keyed by the executable, so the cached read serves it without spawning",
    async () => {
      const stateDirectory = await mkdtemp(join(tmpdir(), "coforge-antigravity-catalog-state-"));
      const binDirectory = await mkdtemp(join(tmpdir(), "coforge-antigravity-catalog-bin-")).catch(
        async (error: unknown) => {
          await rm(stateDirectory, { recursive: true, force: true });
          throw error;
        },
      );
      const agyPath = join(binDirectory, "agy");
      try {
        await Bun.write(agyPath, "#!/bin/sh\nexit 0\n");
        const runtimes = [
          { provider: "antigravity" as const, version: "1.5.10", displayName: "Antigravity CLI" },
        ];
        const options = {
          probe: agyProbe("1.5.10\n", agyPath),
          commands: { antigravity: [process.execPath, ACP_FIXTURE] as const },
          environment: { ...environment, AGY_ACP_FIXTURE_CONFIG_OPTIONS: ACP_MODELS },
          piModels: async () => [],
          cacheDirectory: stateDirectory,
        };
        const { catalogs: live } = await discoverCodeAgentCatalogs(runtimes, options);
        expect(live.find((catalog) => catalog.provider === "antigravity")?.models).toHaveLength(2);

        const cached = await loadCachedCodeAgentCatalogs(runtimes, {
          probe: options.probe,
          piModels: options.piModels,
          environment,
          cacheDirectory: stateDirectory,
        });
        expect(
          cached.catalogs.find((catalog) => catalog.provider === "antigravity")?.models,
        ).toHaveLength(2);
      } finally {
        await rm(stateDirectory, { recursive: true, force: true });
        await rm(binDirectory, { recursive: true, force: true });
      }
    },
    PASS_BUDGET_MS,
  );

  test("invalidates the cached catalog when the account or CLI version changes", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "coforge-antigravity-catalog-state-"));
    const binDirectory = await mkdtemp(join(tmpdir(), "coforge-antigravity-catalog-bin-"));
    const home = await mkdtemp(join(tmpdir(), "coforge-antigravity-catalog-home-"));
    const geminiDirectory = join(home, ".gemini");
    const agyPath = join(binDirectory, "agy");
    try {
      await Bun.write(agyPath, "#!/bin/sh\nexit 0\n");
      await mkdir(geminiDirectory, { recursive: true });
      await Bun.write(join(geminiDirectory, "google_account_id"), "account-one");
      await Bun.write(join(geminiDirectory, "oauth_creds.json"), '{"expiry_date":1}');
      const environment = { HOME: home, PATH: "", PI_OFFLINE: "1" };
      const options = {
        probe: agyProbe("1.5.10\n", agyPath),
        commands: { antigravity: [process.execPath, ACP_FIXTURE] as const },
        environment: { ...environment, AGY_ACP_FIXTURE_CONFIG_OPTIONS: ACP_MODELS },
        piModels: async () => [],
        cacheDirectory: stateDirectory,
      };
      const runtime = (version: string) => [
        { provider: "antigravity" as const, version, displayName: "Antigravity CLI" },
      ];
      const served = async (version = "1.5.10") =>
        (await loadCachedCodeAgentCatalogs(runtime(version), options)).catalogs.some(
          (catalog) => catalog.provider === "antigravity",
        );

      await discoverCodeAgentCatalogs(runtime("1.5.10"), options);
      const cachedKey = (await Bun.file(
        join(stateDirectory, "code-agent-inventory-cache.json"),
      ).json()) as { antigravity?: { key?: string } };
      expect(cachedKey.antigravity?.key).toContain("1.5.10|");
      expect(await served()).toBe(true);

      await Bun.write(join(geminiDirectory, "oauth_creds.json"), '{"expiry_date":2}');
      expect(await served()).toBe(true);

      await Bun.write(join(geminiDirectory, "google_account_id"), "account-two");
      expect(await served()).toBe(false);

      await discoverCodeAgentCatalogs(runtime("1.5.10"), options);
      expect(await served()).toBe(true);
      expect(await served("1.5.11")).toBe(false);

      await Bun.file(join(geminiDirectory, "google_account_id")).delete();
      await Bun.file(join(geminiDirectory, "oauth_creds.json")).delete();
      expect(await served()).toBe(false);
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
      await rm(binDirectory, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test("catalog cache key honors GEMINI_HOME and detects agy 1.5.x antigravity-oauth-token", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "coforge-antigravity-gemini-home-state-"));
    const binDirectory = await mkdtemp(join(tmpdir(), "coforge-antigravity-gemini-home-bin-"));
    const home = await mkdtemp(join(tmpdir(), "coforge-antigravity-gemini-home-home-"));
    const customGemini = await mkdtemp(join(tmpdir(), "coforge-antigravity-gemini-home-custom-"));
    const agyPath = join(binDirectory, "agy");
    try {
      await Bun.write(agyPath, "#!/bin/sh\nexit 0\n");
      const tokenPath = join(customGemini, "antigravity-cli", "antigravity-oauth-token");
      await mkdir(join(customGemini, "antigravity-cli"), { recursive: true });
      await Bun.write(tokenPath, "synthetic-token");
      const env = { HOME: home, GEMINI_HOME: customGemini, PATH: "", PI_OFFLINE: "1" };
      const options = {
        probe: agyProbe("1.5.10\n", agyPath),
        commands: { antigravity: [process.execPath, ACP_FIXTURE] as const },
        environment: { ...env, AGY_ACP_FIXTURE_CONFIG_OPTIONS: ACP_MODELS },
        piModels: async () => [],
        cacheDirectory: stateDirectory,
      };
      const runtimes = [
        { provider: "antigravity" as const, version: "1.5.10", displayName: "Antigravity CLI" },
      ];
      await discoverCodeAgentCatalogs(runtimes, options);
      const cached = (await Bun.file(
        join(stateDirectory, "code-agent-inventory-cache.json"),
      ).json()) as { antigravity?: { key?: string } };
      expect(cached.antigravity?.key).toMatch(/\|credentials$/);

      await Bun.file(tokenPath).delete();
      const afterSignOut = await loadCachedCodeAgentCatalogs(runtimes, options);
      expect(afterSignOut.catalogs.some((catalog) => catalog.provider === "antigravity")).toBe(
        false,
      );
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
      await rm(binDirectory, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
      await rm(customGemini, { recursive: true, force: true });
    }
  });
});
