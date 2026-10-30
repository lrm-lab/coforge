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
import { discoverExternalCodeAgents } from "#src/code-agent/runtime-probe";
import { anvilRuntimeFixtures } from "./fixtures/anvil-runtime";

const ACP_TIMEOUT_MS = 10_000;
const TEST_BUDGET_MS =
  VERSION_PROBE_TIMEOUT_MS + 3 * ACP_TIMEOUT_MS + 2 * PROCESS_TREE_EXIT_GRACE_MS;

test(
  "DSH inventory advertises the pinned release and keeps its catalog in the process cache only",
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
        spawn: () => ({ stdout: new Blob(["0.2.1-rc.2\n"]).stream(), exited: Promise.resolve(0) }),
      },
      piModels: async () => [],
      cacheDirectory: join(cwd, "daemon-cache"),
      catalogDiscoveryTimeoutMs: ACP_TIMEOUT_MS,
    };
    try {
      expect(
        (await discoverCodeAgentRuntimes(options)).find((runtime) => runtime.provider === "dsh"),
      ).toEqual(runtimes[0]);
      expect(
        (await loadCachedCodeAgentCatalogs(runtimes, options)).catalogs.some(
          (entry) => entry.provider === "dsh",
        ),
      ).toBe(false);
      expect(await Bun.file(log).exists()).toBe(false);
      const { catalogs } = await discoverCodeAgentCatalogs(runtimes, options);
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
      // The runtime's version probe is cached like any CLI's; its model catalog is not.
      if (await disk.exists()) expect(await disk.text()).not.toContain("native-model");
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
  "a failed DSH probe keeps the other catalogs, background and explicit refresh alike",
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
      const { catalogs } = await discoverCodeAgentCatalogs(runtimes, options);
      expect(catalogs.some((catalog) => catalog.provider === "coforge")).toBe(true);
      expect(catalogs.some((catalog) => catalog.provider === "dsh")).toBe(false);
      // An explicit refresh is one provider's failure too: the other catalogs still come back.
      const { catalogs: forced } = await discoverCodeAgentCatalogs(runtimes, {
        ...options,
        force: true,
      });
      expect(forced.some((catalog) => catalog.provider === "coforge")).toBe(true);
      expect(forced.some((catalog) => catalog.provider === "dsh")).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  TEST_BUDGET_MS,
);

test("DSH inventory refuses any release other than the pinned one", async () => {
  const probe = (version: string) => ({
    which: (name: string) => (name === "dsh" ? "/bin/dsh" : undefined),
    spawn: () => ({ stdout: new Blob([`${version}\n`]).stream(), exited: Promise.resolve(0) }),
  });
  await expect(discoverExternalCodeAgents(probe("0.2.1-rc.2"))).resolves.toEqual([
    { provider: "dsh", version: "0.2.1-rc.2", displayName: "DeepSeek Harness" },
  ]);
  const refused = (version: string) => ({
    provider: "dsh" as const,
    version,
    displayName: "DeepSeek Harness",
    unavailableCode: "version_unsupported" as const,
  });
  // A refused release stays listed, unusable, so the page can say why.
  await expect(discoverExternalCodeAgents(probe("0.2.1"))).resolves.toEqual([refused("0.2.1")]);
  await expect(discoverExternalCodeAgents(probe("0.2.0"))).resolves.toEqual([refused("0.2.0")]);
  // Launch accepts only the bare version, so the inventory must not offer decorated output.
  await expect(discoverExternalCodeAgents(probe("dsh 0.2.1-rc.2"))).resolves.toEqual([
    refused("dsh 0.2.1-rc.2"),
  ]);
});
