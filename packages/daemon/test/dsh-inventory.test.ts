import { expect, test } from "bun:test";
import { mkdir, chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PROCESS_TREE_EXIT_GRACE_MS, VERSION_PROBE_TIMEOUT_MS } from "@lrm/coforge-anvil";
import { createCodeAgentProvider } from "#src/code-agent/registry";
import {
  discoverCodeAgentRuntimes,
  discoverCodeAgentCatalogs,
  loadCachedCodeAgentCatalogs,
} from "#src/code-agent/runtime-inventory";
import { anvilRuntimeFixtures } from "./fixtures/anvil-runtime";

const ACP_TIMEOUT_MS = 10_000;
const TEST_BUDGET_MS =
  VERSION_PROBE_TIMEOUT_MS + 3 * ACP_TIMEOUT_MS + 2 * PROCESS_TREE_EXIT_GRACE_MS;

test(
  "DSH inventory uses the native exchange and process cache without advertising or persisting it",
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), "dsh-inventory-"));
    const log = join(cwd, "rpc.jsonl");
    const runtimes = [
      { provider: "dsh" as const, version: "0.2.1-rc.2", displayName: "DeepSeek Harness" },
    ];
    const options = {
      cwd,
      environment: {
        HOME: cwd,
        DSH_HOME: join(cwd, "native-home"),
        PATH: "",
        DSH_FIXTURE_LOG: log,
      },
      commands: { dsh: [process.execPath, anvilRuntimeFixtures.dsh] },
      probe: {
        which: (name: string) => (name === "dsh" ? process.execPath : undefined),
        spawn: () => {
          throw new Error("hidden DSH must not be version-probed at startup");
        },
      },
      piModels: async () => [],
      cacheDirectory: join(cwd, "daemon-cache"),
      catalogDiscoveryTimeoutMs: ACP_TIMEOUT_MS,
    };
    try {
      expect(
        (await discoverCodeAgentRuntimes(options)).some((runtime) => runtime.provider === "dsh"),
      ).toBe(false);
      expect(
        (await loadCachedCodeAgentCatalogs(runtimes, options)).catalogs.some(
          (entry) => entry.provider === "dsh",
        ),
      ).toBe(false);
      expect(await Bun.file(log).exists()).toBe(false);
      const catalogs = await discoverCodeAgentCatalogs(runtimes, options);
      expect(catalogs.find((entry) => entry.provider === "dsh")?.models[0]?.id).toBe(
        "native-model",
      );
      const cached = await loadCachedCodeAgentCatalogs(runtimes, options);
      expect(cached.catalogs.find((entry) => entry.provider === "dsh")).toEqual(
        catalogs.find((entry) => entry.provider === "dsh"),
      );
      await discoverCodeAgentCatalogs(runtimes, options);
      const requests = (await Bun.file(log).text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(requests.map((request) => request.method)).toEqual([
        "initialize",
        "session/new",
        "session/close",
      ]);
      const probeCwd = requests.find((request) => request.method === "session/new").params.cwd;
      await expect(stat(probeCwd)).rejects.toMatchObject({ code: "ENOENT" });
      const disk = Bun.file(join(options.cacheDirectory, "code-agent-inventory-cache.json"));
      if (await disk.exists()) expect(await disk.text()).not.toContain('"dsh"');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  TEST_BUDGET_MS,
);

test(
  "DSH registry launches the absolute executable resolved from the Computer PATH",
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), "dsh-resolved-executable-"));
    const executable = join(cwd, "bin", "dsh");
    const log = join(cwd, "rpc.jsonl");
    const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
    await mkdir(dirname(executable), { recursive: true });
    await Bun.write(
      executable,
      `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(anvilRuntimeFixtures.dsh)} "$@"\n`,
    );
    await chmod(executable, 0o755);
    try {
      const provider = createCodeAgentProvider("dsh", {
        environment: { HOME: cwd, PATH: dirname(executable) },
      });
      let nativeSessionId: string | undefined;
      const session = await provider.createAgentSession({
        agentWorkspaceDirectory: cwd,
        instructions: "literal {{x}}",
        environment: { DSH_FIXTURE_LOG: log, PATH: "/usr/bin:/bin" },
        onSessionId: async (id) => {
          nativeSessionId = id;
        },
      });
      try {
        expect(nativeSessionId).toBe("dsh-fixture-session");
      } finally {
        await session.dispose();
      }
      expect(await Bun.file(log).text()).toContain("session/new");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  TEST_BUDGET_MS,
);

test(
  "a failed background DSH probe keeps other catalogs while explicit refresh reports failure",
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), "dsh-inventory-failure-"));
    const options = {
      cwd,
      environment: { HOME: cwd, DSH_HOME: join(cwd, "home"), PATH: "" },
      commands: { dsh: [process.execPath] },
      probe: {
        which: (name: string) => (name === "dsh" ? process.execPath : undefined),
        spawn: () => {
          throw new Error("no runtime probe");
        },
      },
      piModels: async () => [],
    };
    const runtimes = [
      { provider: "dsh" as const, version: "0.2.1-rc.2", displayName: "DeepSeek Harness" },
    ];
    try {
      const catalogs = await discoverCodeAgentCatalogs(runtimes, options);
      expect(catalogs.some((catalog) => catalog.provider === "coforge")).toBe(true);
      expect(catalogs.some((catalog) => catalog.provider === "dsh")).toBe(false);
      await expect(
        discoverCodeAgentCatalogs(runtimes, { ...options, force: true }),
      ).rejects.toThrow();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  TEST_BUDGET_MS,
);
