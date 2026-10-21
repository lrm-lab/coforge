import { describe, expect, test } from "bun:test";
import { discoverPiModels, PI_SDK_VERSION } from "@coforge/agent";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverCodeAgentInventory,
  discoverCodeAgentRuntimes,
} from "#src/code-agent/runtime-inventory";
import { discoverExternalCodeAgents } from "#src/code-agent/runtime-probe";
import type { ExternalCodeAgentProbe } from "#src/code-agent/runtime-executable";
import { fileStatCacheKey, inventoryCachePath } from "#src/code-agent/runtime-inventory-cache";
import {
  probeClaudeCodeVersion,
  resolveClaudeCodeExecutable,
} from "#src/code-agent/claude-code/runtime";
import { COFORGE_DAEMON_VERSION } from "#src/version";
import { VERSION_PROBE_TIMEOUT_MS } from "#src/code-agent/version-gate";
import { CATALOG_DISCOVERY_BUDGET_MS } from "./catalog-discovery-budget";
import { FULL_EFFORTS, probeFor } from "./fixtures/runtime-probe";

/** The hung version probe test gives up this soon, so it need not wait out production's. */
const SHORT_VERSION_PROBE_TIMEOUT_MS = 50;

describe("external Code Agent inventory", () => {
  test("reports embedded Pi and discovers custom models from host Pi resources", async () => {
    const home = await mkdtemp(join(tmpdir(), "coforge-pi-inventory-"));
    const agentDir = join(home, ".pi", "agent");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          fixture: {
            baseUrl: "http://localhost.invalid/v1",
            apiKey: "local",
            models: [{ id: "host-model", name: "Host Model", api: "openai-completions" }],
          },
        },
      }),
    );
    try {
      const inventory = await discoverCodeAgentInventory({
        probe: probeFor({}),
        // The real Pi SDK discovery, on purpose: the hermetic fixture home is what it reads.
        piModels: discoverPiModels,
        cwd: home,
        environment: { HOME: home, PATH: "", PI_OFFLINE: "1" },
      });
      expect(inventory.runtimes).toContainEqual({
        provider: "pi",
        version: PI_SDK_VERSION,
        displayName: "Pi",
      });
      expect(
        inventory.catalogs.find((catalog) => catalog.provider === "pi")?.models,
      ).toContainEqual(expect.objectContaining({ id: "host-model", modelProvider: "fixture" }));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("searches user CLI directories when the Daemon service PATH is minimal", async () => {
    const searchedPaths: string[] = [];
    const probe: ExternalCodeAgentProbe = {
      which(name, searchPath) {
        searchedPaths.push(searchPath ?? "");
        if (name === "codex" && searchPath?.includes("/Users/frank/.local/bin")) {
          return "/Users/frank/.local/bin/codex";
        }
        if (name === "claude" && searchPath?.includes("/Users/frank/.local/bin")) {
          return "/Users/frank/.local/bin/claude";
        }
        if (name === "kiro-cli" && searchPath?.includes("/Users/frank/.local/bin")) {
          return "/Users/frank/.local/bin/kiro-cli";
        }
        return undefined;
      },
      spawn: (executable) => ({
        stdout: new Blob([
          executable.endsWith("codex")
            ? "codex-cli 0.151.0"
            : executable.endsWith("kiro-cli")
              ? "kiro-cli 2.21.2"
              : "2.1.0",
        ]).stream(),
        exited: Promise.resolve(0),
      }),
    };

    await expect(
      discoverExternalCodeAgents(probe, {
        HOME: "/Users/frank",
        PATH: "/usr/bin:/bin",
      }),
    ).resolves.toEqual([
      { provider: "codex", version: "0.151.0", displayName: "Codex" },
      { provider: "claude-code", version: "2.1.0", displayName: "Claude Code" },
      { provider: "kiro", version: "2.21.2", displayName: "Kiro" },
    ]);
    expect(searchedPaths.every((path) => path.includes("/Users/frank/.local/bin"))).toBe(true);
  });

  test("does not scan PATH for Pi because its SDK is embedded", async () => {
    const searchedPaths: string[] = [];
    const probe: ExternalCodeAgentProbe = {
      which(name, searchPath) {
        searchedPaths.push(searchPath ?? "");
        if (name === "pi" && searchPath?.includes("/opt/homebrew/bin")) {
          return "/opt/homebrew/bin/pi";
        }
        return undefined;
      },
      spawn: () => ({
        stdout: new Blob(["0.84.4\n"]).stream(),
        exited: Promise.resolve(0),
      }),
    };

    await expect(
      discoverExternalCodeAgents(
        probe,
        {
          HOME: "/Users/frank",
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        },
        "darwin",
      ),
    ).resolves.toEqual([]);
    expect(searchedPaths.every((path) => path.includes("/usr/local/bin"))).toBe(true);
  });

  test("resolves Claude Code from PATH before any platform fallback", async () => {
    await expect(resolveClaudeCodeExecutable(() => "/custom/bin/claude")).resolves.toBe(
      "/custom/bin/claude",
    );
  });

  test("parses Claude Code's version from its version output", async () => {
    await expect(
      probeClaudeCodeVersion("/bin/claude", () => ({
        stdout: new Blob(["Claude Code 2.1.7 (build abc)\n"]).stream(),
        exited: Promise.resolve(0),
      })),
    ).resolves.toBe("2.1.7");
  });

  test("does not inventory Claude Code when version probing fails", async () => {
    let killed = false;
    await expect(
      probeClaudeCodeVersion("/bin/claude", () => ({
        stdout: new Blob(["error\n"]).stream(),
        exited: Promise.resolve(1),
        kill: () => {
          killed = true;
        },
      })),
    ).resolves.toBeUndefined();
    expect(killed).toBe(true);
  });

  test("keeps a cached runtime when a later version probe temporarily fails", async () => {
    const home = await mkdtemp(join(tmpdir(), "coforge-runtime-cache-fallback-"));
    const executable = join(home, "codex");
    await Bun.write(executable, "fixture");
    const key = await fileStatCacheKey([executable]);
    expect(key).toBeDefined();
    await Bun.write(
      inventoryCachePath(home),
      JSON.stringify({
        codex: {
          key,
          runtime: { provider: "codex", version: "0.151.0", displayName: "Codex" },
        },
      }),
    );
    try {
      const probe: ExternalCodeAgentProbe = {
        which: (name) => (name === "codex" ? executable : undefined),
        probe: async () => undefined,
        spawn: () => ({
          stdout: new Blob(["broken\n"]).stream(),
          exited: Promise.resolve(1),
        }),
      };
      await expect(
        discoverExternalCodeAgents(probe, { HOME: home, PATH: "" }, "linux", undefined, home),
      ).resolves.toContainEqual({
        provider: "codex",
        version: "0.151.0",
        displayName: "Codex",
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("starts independent external runtime probes concurrently while preserving provider order", async () => {
    const started: string[] = [];
    let release!: () => void;
    const allStarted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const paths = {
      claude: "/bin/claude",
      "kiro-cli": "/bin/kiro-cli",
    };
    const probe: ExternalCodeAgentProbe = {
      which: (name) => paths[name as keyof typeof paths],
      spawn: (executable) => {
        started.push(executable);
        if (started.length === 2) release();
        const output = executable.endsWith("claude") ? "2.1.0\n" : "kiro-cli 2.21.2\n";
        return {
          stdout: new Blob([output]).stream(),
          exited: allStarted.then(() => 0),
        };
      },
    };

    await expect(discoverExternalCodeAgents(probe)).resolves.toEqual([
      { provider: "claude-code", version: "2.1.0", displayName: "Claude Code" },
      { provider: "kiro", version: "2.21.2", displayName: "Kiro" },
    ]);
    expect(started).toEqual(["/bin/claude", "/bin/kiro-cli"]);
  }, 6_000);

  test("kills a Claude Code version probe that exceeds its timeout", async () => {
    let killed = false;
    await expect(
      probeClaudeCodeVersion(
        "/bin/claude",
        () => ({
          stdout: new ReadableStream(),
          exited: new Promise(() => {}),
          kill: () => {
            killed = true;
          },
        }),
        10,
      ),
    ).resolves.toBeUndefined();
    expect(killed).toBe(true);
  });

  test("detects Codex, Claude Code, Kiro, and Cursor CLI as external runtimes without installed Pi", async () => {
    const runtimes = await discoverExternalCodeAgents(
      probeFor({
        codex: { path: "/bin/codex", version: "codex-cli 0.151.0\n" },
        claude: { path: "/bin/claude", version: "2.1.0\n" },
        "kiro-cli": { path: "/bin/kiro-cli", version: "kiro-cli 2.21.2\n" },
        "cursor-agent": { path: "/bin/cursor-agent", version: "2026.08.11-e8db854\n" },
        pi: { path: "/bin/pi", version: "0.9.1\n" },
      }),
    );

    expect(runtimes).toEqual([
      { provider: "codex", version: "0.151.0", displayName: "Codex" },
      { provider: "claude-code", version: "2.1.0", displayName: "Claude Code" },
      { provider: "kiro", version: "2.21.2", displayName: "Kiro" },
      { provider: "cursor", version: "2026.08.11-e8db854", displayName: "Cursor CLI" },
    ]);
  });

  test("omits unusable executables", async () => {
    await expect(
      discoverExternalCodeAgents(
        probeFor({ codex: { path: "/bin/codex", version: "", exitCode: 1 } }),
      ),
    ).resolves.toEqual([]);
  });

  test("uses the Codex app-server probe before reporting the runtime", async () => {
    const probed: string[] = [];
    const probe = probeFor({ codex: { path: "/bin/codex", version: "0.151.0" } });
    probe.probe = async (provider, executable) => {
      probed.push(`${provider}:${executable}`);
      return "0.151.0";
    };

    await expect(discoverExternalCodeAgents(probe)).resolves.toEqual([
      { provider: "codex", version: "0.151.0", displayName: "Codex" },
    ]);
    expect(probed).toEqual(["codex:/bin/codex"]);
  });

  test(
    "preserves an installed Kiro runtime when its catalog is unavailable",
    async () => {
      const inventory = await discoverCodeAgentInventory({
        probe: probeFor({
          "kiro-cli": { path: "/bin/kiro-cli", version: "kiro-cli 2.21.2\n" },
        }),
        commands: { kiro: [process.execPath, "-e", "process.exit(1)"] },
        environment: { HOME: "/fixture/home", PATH: "" },
        // This case asserts Kiro inventory, not the host Pi SDK's network-backed catalog.
        piModels: async () => [],
      });

      expect(inventory.runtimes).toContainEqual({
        provider: "kiro",
        version: "2.21.2",
        displayName: "Kiro",
      });
      expect(inventory.catalogs.some((catalog) => catalog.provider === "kiro")).toBe(false);
    },
    CATALOG_DISCOVERY_BUDGET_MS,
  );

  test("discovers a Cursor CLI model catalog for an installed runtime", async () => {
    const inventory = await discoverCodeAgentInventory({
      probe: probeFor({
        "cursor-agent": { path: "/bin/cursor-agent", version: "2026.08.11-e8db854\n" },
      }),
      commands: {
        cursor: [
          process.execPath,
          new URL("./fixtures/cursor-agent-fixture.ts", import.meta.url).pathname,
          "models",
        ],
      },
      environment: {
        HOME: "/fixture/home",
        PATH: "",
        COFORGE_CURSOR_MODELS_OUTPUT: "Available models\n\nauto - Auto (default)\n",
      },
      piModels: async () => [],
    });

    expect(inventory.runtimes).toContainEqual({
      provider: "cursor",
      version: "2026.08.11-e8db854",
      displayName: "Cursor CLI",
    });
    expect(inventory.catalogs.find((catalog) => catalog.provider === "cursor")).toEqual({
      provider: "cursor",
      models: [
        {
          id: "auto",
          displayName: "Auto",
          description: "",
          modelProvider: "",
          reasoningEfforts: [],
          defaultReasoning: "",
          recommended: true,
        },
      ],
    });
  });

  test(
    "does not wait indefinitely for a runtime version probe",
    async () => {
      // Production's probes wait this long.
      expect(VERSION_PROBE_TIMEOUT_MS).toBe(5_000);
      let killed = false;
      const probe: ExternalCodeAgentProbe = {
        which: (name) => (name === "codex" ? "/bin/codex" : undefined),
        spawn: () => ({
          stdout: new ReadableStream(),
          exited: new Promise(() => {}),
          kill: () => {
            killed = true;
          },
        }),
      };

      const runtimes = await discoverCodeAgentRuntimes({
        probe,
        piModels: async () => [],
        versionProbeTimeoutMs: SHORT_VERSION_PROBE_TIMEOUT_MS,
      });
      expect(runtimes.filter((runtime) => runtime.provider === "codex")).toEqual([]);
      expect(killed).toBe(true);
    },
    SHORT_VERSION_PROBE_TIMEOUT_MS + 1_000,
  );

  test("discovers Codex and Pi catalogs and reports the maintained Claude Code catalog", async () => {
    const fixture = (name: string) =>
      [process.execPath, new URL(`./fixtures/${name}`, import.meta.url).pathname] as const;
    const inventory = await discoverCodeAgentInventory({
      probe: probeFor({
        codex: { path: "/bin/codex", version: "codex-cli 0.151.0\n" },
        claude: { path: "/bin/claude", version: "2.1.293 (Claude Code)\n" },
        pi: { path: "/bin/pi", version: "0.9.1\n" },
      }),
      commands: {
        codex: fixture("codex-app-server.ts"),
      },
      environment: { HOME: "/fixture/home", PATH: "", PI_OFFLINE: "1" },
      piModels: async () => [],
    });

    expect(inventory.runtimes[0]).toEqual({
      provider: "coforge",
      version: COFORGE_DAEMON_VERSION,
      displayName: "CoForge",
    });
    expect(inventory.runtimes[1]).toEqual({
      provider: "pi",
      version: PI_SDK_VERSION,
      displayName: "Pi",
    });
    const coforgeCatalog = inventory.catalogs.find((catalog) => catalog.provider === "coforge");
    expect(coforgeCatalog).toBeDefined();
    expect(coforgeCatalog?.models.length).toBeGreaterThan(0);
    expect(coforgeCatalog?.models.length).toBeLessThanOrEqual(200);
    expect(new Set(coforgeCatalog?.models.map((model) => model.modelProvider))).toEqual(
      new Set([
        "deepseek",
        "minimax",
        "minimax-cn",
        "zai",
        "zai-coding-cn",
        "moonshotai",
        "moonshotai-cn",
        "kimi-coding",
        "qwen-token-plan",
        "qwen-token-plan-cn",
        "openrouter",
        "openai",
        "anthropic",
        "google",
        "xai",
        "xiaomi",
      ]),
    );
    expect(coforgeCatalog?.models).toContainEqual(
      expect.objectContaining({ id: "aion-labs/aion-2.0", modelProvider: "openrouter" }),
    );
    expect(coforgeCatalog?.models).toContainEqual(
      expect.objectContaining({ id: "deepseek/deepseek-chat", modelProvider: "openrouter" }),
    );
    const piCatalog = inventory.catalogs.find((catalog) => catalog.provider === "pi");
    expect(piCatalog).toEqual({ provider: "pi", models: [] });
    expect(inventory.catalogs.filter((catalog) => catalog.provider !== "pi")).toEqual([
      coforgeCatalog!,
      {
        provider: "codex",
        models: [
          {
            id: "gpt-5.6-sol",
            displayName: "GPT-5.6 Sol",
            description: "Primary coding model",
            modelProvider: "",
            reasoningEfforts: ["low", "medium", "high"],
            defaultReasoning: "low",
            recommended: true,
            supportsFastMode: true,
          },
        ],
      },
      {
        provider: "claude-code",
        models: [
          ...(
            [
              ["opus", "Claude Opus", FULL_EFFORTS],
              ["fable", "Claude Fable", FULL_EFFORTS],
              ["sonnet", "Claude Sonnet", FULL_EFFORTS],
              ["haiku", "Claude Haiku"],
              ["claude-opus-5-5", "Claude Opus 5.5", FULL_EFFORTS],
              ["claude-opus-5", "Claude Opus 5", FULL_EFFORTS],
              ["claude-opus-4-8", "Claude Opus 4.8", FULL_EFFORTS],
              ["claude-opus-4-7", "Claude Opus 4.7", FULL_EFFORTS],
              ["claude-opus-4-6", "Claude Opus 4.6", FULL_EFFORTS],
              ["claude-fable-5-1", "Claude Fable 5.1", FULL_EFFORTS],
              ["claude-fable-5", "Claude Fable 5", FULL_EFFORTS],
              ["claude-sonnet-5-5", "Claude Sonnet 5.5", FULL_EFFORTS],
              ["claude-sonnet-5", "Claude Sonnet 5", FULL_EFFORTS],
              ["claude-sonnet-4-6", "Claude Sonnet 4.6", FULL_EFFORTS],
              ["claude-haiku-5-5", "Claude Haiku 5.5", FULL_EFFORTS],
              ["claude-haiku-4-5", "Claude Haiku 4.5"],
            ] as const
          ).map(([id, displayName, efforts]) => ({
            id,
            displayName,
            description: "",
            modelProvider: "",
            reasoningEfforts: efforts ? efforts.slice() : [],
            defaultReasoning: efforts ? "medium" : "",
            recommended: false,
          })),
        ],
      },
    ]);
  });
});
