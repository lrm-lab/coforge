import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { PROCESS_TREE_EXIT_GRACE_MS, PROCESS_OUTPUT_DRAIN_MS } from "@lrm/coforge-anvil";
import {
  discoverCodeAgentInventory,
  discoverCodeAgentRuntimes,
  loadCachedCodeAgentCatalogs,
} from "#src/code-agent/runtime-inventory";
import { discoverExternalCodeAgents, hostCodeAgentProbe } from "#src/code-agent/runtime-probe";
import { RuntimeManageRunner } from "#src/daemon-runtime/runtime-manage-handler";
import { createCodeAgentProvider, createRuntimeAuthAdapter } from "#src/code-agent/registry";
import {
  CODEX_PROBE_TIMEOUT_MS,
  CODEX_PROBE_BUDGET_MULTIPLIER,
} from "#src/code-agent/codex/executable-probe";
import {
  fileStatCacheKey,
  readInventoryCache,
  writeInventoryCache,
} from "#src/code-agent/runtime-inventory-cache";
import { anvilRuntimeFixtures } from "./fixtures/anvil-runtime";

const TEST_PROBE_TIMEOUT_MS = 1_200;
const TEST_TIMEOUT_MS =
  CODEX_PROBE_BUDGET_MULTIPLIER * CODEX_PROBE_TIMEOUT_MS +
  2 * PROCESS_TREE_EXIT_GRACE_MS +
  PROCESS_OUTPUT_DRAIN_MS +
  20_000;
const ready = { provider: "codex", displayName: "Codex", version: "0.169.0" } as const;
const unavailable = { ...ready, version: "", unavailableCode: "probe_failed" } as const;

function quote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

async function writeExecutable(path: string, source: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, "#!/bin/sh\n" + source);
  await chmod(path, 0o755);
}

type CodexBehavior = "ready" | "exit" | "hang" | "version-hang";

async function fixture(run: (context: Awaited<ReturnType<typeof makeFixture>>) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "coforge-codex-fallback-"));
  try {
    await run(await makeFixture(home));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function makeFixture(home: string) {
  const primary = join(home, "path", "codex");
  const backup = join(home, "installed", "codex");
  const trace = join(home, "processes.log");
  const state = join(home, "state");
  const lastPid = join(home, "last-pid");
  const overlap = join(home, "overlap");
  const probe = {
    ...hostCodeAgentProbe,
    which: (name: string, path?: string) => {
      const executable = hostCodeAgentProbe.which(name, path);
      return executable?.startsWith(home + "/") ? executable : undefined;
    },
    exists: (path: string) => path.startsWith(home + "/") && Bun.file(path).exists(),
  };
  await mkdir(state);
  const environment = {
    HOME: home,
    CODEX_HOME: join(home, ".codex"),
    CODEX_INSTALL_DIR: dirname(backup),
    PATH: dirname(primary),
    PI_OFFLINE: "1",
  };
  const options = {
    cwd: home,
    probe,
    environment,
    provider: "codex" as const,
    piModels: async () => [],
    cacheDirectory: state,
  };
  return {
    home,
    primary,
    backup,
    trace,
    state,
    environment,
    options,
    write: (path: string, behavior: CodexBehavior) => {
      const appServer = {
        ready: `exec ${quote(process.execPath)} ${quote(anvilRuntimeFixtures.codex)}`,
        exit: "exit 42",
        hang: "while read -r line; do :; done",
        "version-hang": `exec ${quote(process.execPath)} ${quote(anvilRuntimeFixtures.codex)}`,
      }[behavior];
      const version =
        behavior === "version-hang"
          ? `exec ${quote(process.execPath)} -e 'setInterval(() => {}, 1000)'`
          : "printf 'codex-cli 0.169.0\\n'";
      return writeExecutable(
        path,
        `if [ -f ${quote(lastPid)} ]; then
  read -r previous_pid < ${quote(lastPid)}
  if kill -0 "$previous_pid" 2>/dev/null; then printf 'overlap' > ${quote(overlap)}; fi
fi
printf '%s\\n' "$$" > ${quote(lastPid)}
printf '%s\\t%s\\t%s\\n' "$$" "$0" "$1" >> ${quote(trace)}
case "$1" in
  --version) ${version} ;;
  app-server) ${appServer} ;;
  login) printf 'Logged in using ChatGPT\\n' ;;
esac
`,
      );
    },
    launches: async () => {
      expect(await Bun.file(overlap).exists()).toBe(false);
      const records = (await Bun.file(trace).text())
        .trim()
        .split("\n")
        .map((line) => line.split("\t"));
      for (const [pid] of records) {
        expect(Number(pid)).toBeGreaterThan(0);
        expect(() => process.kill(Number(pid), 0)).toThrow(
          expect.objectContaining({ code: "ESRCH" }),
        );
      }
      return records.map(([, executable, operation]) => [executable, operation]);
    },
  };
}

test(
  "inventory and registry use the same compatible Codex across cold and cached discovery",
  () =>
    fixture(
      async ({ home, primary, backup, trace, state, environment, options, write, launches }) => {
        await write(primary, "exit");
        await write(backup, "ready");
        const control = await discoverCodeAgentInventory({
          ...options,
          cacheDirectory: undefined,
          environment: { ...environment, PATH: dirname(backup) },
        });
        expect(control.runtimes.find(({ provider }) => provider === "codex")).toEqual(ready);
        expect(control.catalogs.some(({ provider }) => provider === "codex")).toBe(true);
        const primaryKey = (await fileStatCacheKey([primary]))!;
        await writeInventoryCache(state, {
          codex: { key: primaryKey, catalog: { provider: "codex", models: [] } },
        });
        await Bun.write(trace, "");

        const startedAt = performance.now();
        const inventory = await discoverCodeAgentInventory(options);
        expect(inventory.runtimes.find(({ provider }) => provider === "codex")).toEqual(ready);
        const catalog = inventory.catalogs.find(({ provider }) => provider === "codex");
        expect(catalog?.models.length).toBeGreaterThan(0);
        const cached = await readInventoryCache(state);
        expect(cached.codex).toMatchObject({
          key: await fileStatCacheKey([backup], true),
          runtime: ready,
          catalog,
        });
        const cachedCatalogs = await loadCachedCodeAgentCatalogs(inventory.runtimes, options);
        expect(cachedCatalogs.catalogs.find(({ provider }) => provider === "codex")).toEqual(
          catalog,
        );
        expect(cachedCatalogs.refreshProviders).not.toContain("codex");
        const inventoryLaunches = await launches();
        expect(inventoryLaunches).toEqual([
          [primary, "app-server"],
          [backup, "app-server"],
          [backup, "--version"],
          [backup, "app-server"],
        ]);
        const inventoryElapsedMs = Math.round(performance.now() - startedAt);

        await Bun.write(trace, "");
        const warm = await discoverCodeAgentRuntimes(options);
        expect(warm.find(({ provider }) => provider === "codex")).toEqual(ready);
        const auth = createRuntimeAuthAdapter("codex", { environment });
        expect(await auth.readStatus({ workingDirectory: home })).toMatchObject({
          state: "logged_in",
        });
        const session = await createCodeAgentProvider("codex", { environment }).createAgentSession({
          agentWorkspaceDirectory: home,
          environment,
          instructions: "Test Agent instructions.",
        });
        await session.dispose();
        const warmLaunches = await launches();
        expect(warmLaunches).toEqual([
          [primary, "app-server"],
          [backup, "login"],
          [backup, "app-server"],
        ]);
        console.info(
          JSON.stringify({
            inventoryElapsedMs,
            inventoryLaunches,
            warmLaunches,
            remainingProcesses: 0,
          }),
        );
      },
    ),
  TEST_TIMEOUT_MS,
);

test.each(["ready", "exit"] as const)(
  "Codex preserves the first result on %s",
  (behavior) =>
    fixture(async ({ primary, backup, options, write, launches }) => {
      await write(primary, behavior);
      if (behavior === "ready") await write(backup, "ready");
      const runtimes = await discoverCodeAgentRuntimes(options);
      expect(runtimes.find(({ provider }) => provider === "codex")).toEqual(
        behavior === "ready" ? ready : unavailable,
      );
      expect(await launches()).toEqual(
        behavior === "ready"
          ? [
              [primary, "app-server"],
              [primary, "--version"],
            ]
          : [[primary, "app-server"]],
      );
    }),
  TEST_TIMEOUT_MS,
);

test.each(["hang", "version-hang"] as const)(
  "Codex reaps a %s probe before trying the next PATH entry",
  (behavior) =>
    fixture(async ({ home, primary, backup, options, environment, write, launches }) => {
      const secondary = join(home, "second-path", "codex");
      environment.PATH += delimiter + dirname(secondary);
      await write(primary, behavior);
      await write(secondary, "ready");
      await write(backup, "ready");
      const startedAt = performance.now();
      const runtimes = await discoverCodeAgentRuntimes({
        ...options,
        codexProbeTimeoutMs: TEST_PROBE_TIMEOUT_MS,
      });
      expect(runtimes.find(({ provider }) => provider === "codex")).toEqual(ready);
      const elapsedMs = Math.round(performance.now() - startedAt);
      expect(elapsedMs).toBeLessThan(2 * TEST_PROBE_TIMEOUT_MS + 5_000);
      const pathLaunches = await launches();
      expect(pathLaunches).toEqual([
        [primary, "app-server"],
        ...(behavior === "version-hang" ? [[primary, "--version"]] : []),
        [secondary, "app-server"],
        [secondary, "--version"],
      ]);
      console.info(JSON.stringify({ behavior, elapsedMs, pathLaunches, remainingProcesses: 0 }));
    }),
  TEST_TIMEOUT_MS,
);

test(
  "Codex checks both invalid copies in order when the budget remains",
  () =>
    fixture(async ({ primary, backup, options, write, launches }) => {
      await write(primary, "exit");
      await write(backup, "exit");
      const runtimes = await discoverCodeAgentRuntimes(options);
      expect(runtimes.find(({ provider }) => provider === "codex")).toEqual(unavailable);
      expect(await launches()).toEqual([
        [primary, "app-server"],
        [backup, "app-server"],
      ]);
    }),
  TEST_TIMEOUT_MS,
);

test(
  "Codex caps the combined probe time and keeps the first failure if no candidate succeeds",
  () =>
    fixture(async ({ home, primary, backup, options, environment, write, launches }) => {
      expect(CODEX_PROBE_TIMEOUT_MS).toBe(5_000);
      expect(CODEX_PROBE_BUDGET_MULTIPLIER * CODEX_PROBE_TIMEOUT_MS).toBe(10_000);
      const secondary = join(home, "second-path", "codex");
      environment.PATH += delimiter + dirname(secondary);
      await write(primary, "hang");
      await write(secondary, "hang");
      await write(backup, "ready");
      const startedAt = performance.now();
      const runtimes = await discoverCodeAgentRuntimes({
        ...options,
        codexProbeTimeoutMs: TEST_PROBE_TIMEOUT_MS,
      });
      expect(runtimes.find(({ provider }) => provider === "codex")).toEqual(unavailable);
      const elapsedMs = Math.round(performance.now() - startedAt);
      const selectionBudgetMs = CODEX_PROBE_BUDGET_MULTIPLIER * TEST_PROBE_TIMEOUT_MS;
      expect(elapsedMs).toBeGreaterThanOrEqual(selectionBudgetMs - 10);
      expect(elapsedMs).toBeLessThan(selectionBudgetMs + 5_000);
      const pathLaunches = await launches();
      expect(pathLaunches.slice(0, 1)).toEqual([[primary, "app-server"]]);
      expect(pathLaunches.slice(1)).toEqual(
        pathLaunches.length === 1 ? [] : [[secondary, "app-server"]],
      );
      console.info(JSON.stringify({ elapsedMs, pathLaunches, remainingProcesses: 0 }));
    }),
  TEST_TIMEOUT_MS,
);

test(
  "a failing OpenCode PATH copy keeps its existing result",
  () =>
    fixture(async ({ home, environment, options }) => {
      const primary = join(environment.PATH, "opencode");
      const backup = join(home, ".opencode", "bin", "opencode");
      const marker = join(home, "opencode-backup-started");
      await writeExecutable(primary, "exit 42\n");
      await writeExecutable(backup, `printf started > ${quote(marker)}\nprintf '1.15.0\\n'\n`);
      const runtimes = await discoverExternalCodeAgents(
        options.probe,
        environment,
        process.platform,
        "opencode",
      );
      expect(runtimes).toEqual([
        {
          provider: "opencode",
          displayName: "OpenCode",
          version: "",
          unavailableCode: "start_failed",
        },
      ]);
      expect(await Bun.file(marker).exists()).toBe(false);
    }),
  TEST_TIMEOUT_MS,
);

test.each(["removed", "replaced"] as const)(
  "a new Codex session recovers when the selected PATH executable is %s",
  (change) =>
    fixture(async ({ home, primary, backup, environment, options, trace, write, launches }) => {
      await write(primary, "ready");
      await write(backup, "ready");
      const before = await discoverCodeAgentRuntimes(options);
      expect(before.find(({ provider }) => provider === "codex")).toEqual(ready);
      if (change === "removed") await rm(primary);
      else await write(primary, "exit");
      await Bun.write(trace, "");

      const session = await createCodeAgentProvider("codex", { environment }).createAgentSession({
        agentWorkspaceDirectory: home,
        environment,
        instructions: "Review fixture.",
      });
      await session.dispose();
      const auth = createRuntimeAuthAdapter("codex", { environment });
      expect(await auth.readStatus({ workingDirectory: home })).toMatchObject({
        state: "logged_in",
      });
      const pathLaunches = await launches();
      expect(pathLaunches).toEqual([
        ...(change === "replaced" ? [[primary, "app-server"]] : []),
        [backup, "app-server"],
        [backup, "--version"],
        [backup, "app-server"],
        [backup, "login"],
      ]);
      console.info(JSON.stringify({ change, pathLaunches }));
    }),
  TEST_TIMEOUT_MS,
);

test(
  "the first Codex session selects a compatible command without an inventory report",
  () =>
    fixture(async ({ home, primary, backup, environment, write, launches }) => {
      await write(primary, "exit");
      await write(backup, "ready");
      const session = await createCodeAgentProvider("codex", { environment }).createAgentSession({
        agentWorkspaceDirectory: home,
        environment,
        instructions: "Review fixture.",
      });
      await session.dispose();
      const pathLaunches = await launches();
      expect(pathLaunches).toEqual([
        [primary, "app-server"],
        [backup, "app-server"],
        [backup, "--version"],
        [backup, "app-server"],
      ]);
      console.info(JSON.stringify({ entry: "first-session", pathLaunches }));
    }),
  TEST_TIMEOUT_MS,
);

test(
  "the first Codex auth status shares the in-flight inventory selection",
  () =>
    fixture(async ({ home, primary, backup, options, environment, write, launches }) => {
      await write(primary, "exit");
      await write(backup, "ready");
      const auth = createRuntimeAuthAdapter("codex", { environment });
      const [runtimes, status] = await Promise.all([
        discoverCodeAgentRuntimes(options),
        auth.readStatus({ workingDirectory: home }),
      ]);
      expect(runtimes.find(({ provider }) => provider === "codex")).toEqual(ready);
      expect(status).toMatchObject({ state: "logged_in" });
      const pathLaunches = await launches();
      expect(pathLaunches).toEqual([
        [primary, "app-server"],
        [backup, "app-server"],
        [backup, "--version"],
        [backup, "login"],
      ]);
      console.info(JSON.stringify({ entry: "first-auth", pathLaunches }));
    }),
  TEST_TIMEOUT_MS,
);

test(
  "runtime management uses the selected Codex install to plan an upgrade",
  async () => {
    await fixture(async ({ primary, backup, environment, write }) => {
      await write(primary, "exit");
      await write(backup, "ready");
      const inspectedPaths: string[] = [];
      const executed: string[][] = [];
      const runner = new RuntimeManageRunner({
        environment: () => environment,
        resolveRealPath: async (path) => {
          inspectedPaths.push(path);
          return path === backup ? "/fixture/lib/node_modules/@openai/codex/bin/codex.js" : path;
        },
        which: (name) => (name === "npm" ? "/fixture/bin/npm" : undefined),
        runSteps: async (steps) => {
          for (const step of steps) executed.push([...step.command]);
          return { ok: true };
        },
      });
      const result = await runner.execute({
        protocolMajor: 1,
        requestId: "rtm_0123456789abcdef0123456789abcdef",
        workspaceId: "fixture-workspace",
        computerId: "fixture-computer",
        provider: "codex",
        action: "upgrade",
        requestedByUserId: "fixture-user",
        timeoutMs: 15_000,
      });
      console.info({
        requested: inspectedPaths.map((path) => (path === primary ? "PATH" : "installer")),
        status: result.status,
        reason: result.reason,
        executed,
      });
      expect(result).toMatchObject({
        status: "unchanged",
        source: "npm",
        previousVersion: ready.version,
        currentVersion: ready.version,
      });
      expect(inspectedPaths).toEqual([backup]);
      expect(executed).toEqual([["/fixture/bin/npm", "install", "-g", "@openai/codex@latest"]]);
    });
  },
  TEST_TIMEOUT_MS,
);
