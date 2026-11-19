import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, type DoctorCommand } from "#src/cli";
import { runDoctorCleanup } from "#src/doctor/doctor-cleanup";
import {
  createDoctorCommand,
  createDoctorReport,
  renderDoctorHuman,
} from "#src/doctor/doctor-command";
import { collectComputerStatus } from "#src/status/collect-status";
import {
  formatMemoryBytes,
  parseLinuxProcStatusMemory,
  parsePsRssOutput,
  sampleProcessMemory,
} from "#src/status/process-memory";
import { renderStatusHuman } from "#src/status/render-status";
import type { ComputerStatusReport, StatusPorts } from "#src/status/types";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const HEALTHY_STATUS: ComputerStatusReport = {
  schemaVersion: 1,
  generatedAt: "2026-04-01T12:00:00.000Z",
  platform: "linux",
  install: {
    readable: true,
    active: { current: "1.4.2", previous: "1.4.1" },
    binaryOnPath: "/home/user/.local/bin/coforge-computer",
    resolvesToActive: true,
    releaseFeedUrl: "https://releases.coforge.cn/",
  },
  supervisor: {
    label: "coforge-daemon.service",
    loaded: true,
    pid: 4821,
    socketPath: "/home/user/.coforge/daemon/daemon.sock",
    rpc: { reachable: true, runtimeCount: 1 },
  },
  loginShellPath: { state: "imported", shell: "/bin/bash", entryCount: 5 },
  workspaces: {
    readable: true,
    workspaces: [
      {
        workspaceId: "ws-1",
        workspaceSlug: "acme",
        serverHttpUrl: "https://coforge.cn",
        enabled: true,
        running: true,
        pid: 111,
        pidSource: "daemon-snapshot",
        pending: [],
        unsettledUpgrades: [],
        health: { status: "ok" },
        cloudConnection: { state: "connected" },
      },
    ],
  },
  agents: { supported: false, workspaces: [] },
  locks: {
    machineMutationLock: "free",
    supervisorLock: { present: true, ownerPid: 4821 },
  },
  leftoverJobs: { supported: false, jobs: [] },
};

function basePorts(overrides: Partial<StatusPorts> = {}): StatusPorts {
  return {
    now: () => new Date("2026-04-01T12:00:00.000Z"),
    platform: "linux",
    releaseFeedUrl: "https://releases.coforge.cn/",
    socketPath: "/home/user/.coforge/daemon/daemon.sock",
    activeBinaryPath: "/home/user/.coforge/computer/install/active/coforge-computer",
    coordinatorLabel: "coforge-daemon.service",
    readActiveInstall: async () => ({ kind: "present", current: "1.4.2", previous: "1.4.1" }),
    readLoginShellPath: () => ({ state: "imported", shell: "/bin/bash", entryCount: 5 }),
    locateBinaryOnPath: async () => "/home/user/.local/bin/coforge-computer",
    resolveRealPath: async () =>
      "/home/user/.coforge/computer/install/versions/1.4.2/coforge-computer",
    probeCoordinator: async () => ({ loaded: true, pid: 4821 }),
    readServiceDefinition: async () => null,
    probeDaemonSnapshot: async () => ({
      reachable: true,
      version: "1.4.2",
      runtimes: [{ workspaceId: "ws-1", processId: 111 }],
    }),
    loadBindings: async () => ({
      ok: true,
      bindings: [
        {
          workspaceId: "ws-1",
          computerId: "comp-1",
          serverHttpUrl: "https://coforge.cn",
          enabled: true,
        },
      ],
    }),
    listWorkspaceAgents: { supported: false, list: async () => [] },
    probeMachineMutationLock: () => "free",
    readSupervisorLockOwner: async () => 4821,
    listLeftoverUpgradeJobs: { supported: false, list: async () => [] },
    readWorkspaceHealth: async () => ({ status: "ok" }),
    readCloudConnection: async () => ({ state: "connected" }),
    readWorkspaceSlugs: async () => new Map([["ws-1", "acme"]]),
    ...overrides,
  };
}

describe("process memory diagnostics", () => {
  test("parses Linux /proc/<pid>/status RSS and swap and macOS ps RSS", async () => {
    const linuxSample = parseLinuxProcStatusMemory(
      "Name:\tcoforge-computer\nVmSize:\t512000 kB\nVmRSS:\t131072 kB\nVmSwap:\t12288 kB\n",
    );
    expect(linuxSample).toEqual({
      rssBytes: 131_072 * 1024,
      swapBytes: 12_288 * 1024,
    });
    expect(parseLinuxProcStatusMemory("Name:\tempty\n")).toBeUndefined();
    expect(parsePsRssOutput("  98304 \n")).toEqual({ rssBytes: 98_304 * 1024 });
    expect(parsePsRssOutput("not-a-number")).toBeUndefined();
    expect(formatMemoryBytes(128 * 1024 * 1024)).toBe("128 MiB");
    expect(formatMemoryBytes(2.5 * 1024 * 1024 * 1024)).toBe("2.5 GiB");

    const sampled = await sampleProcessMemory(42, {
      platform: "linux",
      readProcStatus: async () => "VmRSS:\t65536 kB\nVmSwap:\t0 kB\n",
    });
    expect(sampled).toEqual({ rssBytes: 65_536 * 1024, swapBytes: 0 });
    expect(await sampleProcessMemory(0, { platform: "linux" })).toBeUndefined();
  });

  test("collectComputerStatus, renderStatusHuman, and doctor surface supervisor and workspace memory", async () => {
    const status = await collectComputerStatus(
      basePorts({
        sampleProcessMemory: async (pid) =>
          pid === 4821
            ? { rssBytes: 128 * 1024 * 1024, swapBytes: 12 * 1024 * 1024 }
            : { rssBytes: 96 * 1024 * 1024 },
      }),
    );

    expect(status.supervisor.memory).toEqual({
      rssBytes: 128 * 1024 * 1024,
      swapBytes: 12 * 1024 * 1024,
    });
    expect(status.workspaces.readable && status.workspaces.workspaces[0]?.memory).toEqual({
      rssBytes: 96 * 1024 * 1024,
    });

    const rendered = renderStatusHuman(status).join("\n");
    expect(rendered).toContain("Memory:                128 MiB RSS (12 MiB swap)");
    expect(rendered).toContain("memory: 96 MiB RSS");

    const healthyDoctor = createDoctorReport(status);
    expect(healthyDoctor.ok).toBe(true);
    expect(healthyDoctor.checks.find((c) => c.name === "memory")).toEqual({
      name: "memory",
      ok: true,
      detail: "supervisor 128 MiB RSS (12 MiB swap); 1 workspace total 96 MiB RSS",
    });

    const bloatedDoctor = createDoctorReport({
      ...status,
      supervisor: {
        ...status.supervisor,
        memory: { rssBytes: 2.5 * 1024 * 1024 * 1024, swapBytes: 600 * 1024 * 1024 },
      },
    });
    expect(bloatedDoctor.ok).toBe(false);
    expect(bloatedDoctor.checks.find((c) => c.name === "memory")).toMatchObject({
      name: "memory",
      ok: false,
    });
    expect(renderDoctorHuman(bloatedDoctor).join("\n")).toContain("Next: coforge-computer restart");
  });
});

describe("doctor runtime CLI downgrades and crash history", () => {
  test("doctor flags accidental runtime CLI downgrades and recent crash history", () => {
    const report = createDoctorReport(HEALTHY_STATUS, {
      runtimeCliDowngrades: [
        {
          provider: "claude_code",
          previousVersion: "2.1.45",
          currentVersion: "2.0.10",
          previousPath: "/opt/homebrew/bin/claude",
          currentPath: "/usr/local/bin/claude",
          detectedAt: "2026-04-01T11:55:00.000Z",
        },
      ],
      crashHistoryByWorkspace: new Map([
        [
          "ws-1",
          {
            recentCrashes: ["2026-04-01T11:59:10.000Z", "2026-04-01T11:59:40.000Z"],
          },
        ],
      ]),
    });

    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === "runtime-cli-versions")).toEqual({
      name: "runtime-cli-versions",
      ok: false,
      detail:
        "claude_code downgraded from 2.1.45 (/opt/homebrew/bin/claude) to 2.0.10 (/usr/local/bin/claude)",
    });
    expect(report.checks.find((c) => c.name === "crash-history")).toEqual({
      name: "crash-history",
      ok: false,
      detail: "acme: 2 recent unexpected exits (latest 2026-04-01T11:59:40.000Z)",
    });
    const human = renderDoctorHuman(report).join("\n");
    expect(human).toContain("✗ runtime-cli-versions:");
    expect(human).toContain("✗ crash-history:");
    expect(human).toContain("coforge-computer logs --workspace");
  });
});

describe("doctor --cleanup", () => {
  test("removes stale locks, detached pid, and aged temp files while preserving live state and symlinks", async () => {
    const stateDir = await makeTempDir("coforge-doctor-cleanup-");
    const wsDir = join(stateDir, "workspaces", "ws-1");
    await mkdir(join(stateDir, "supervisor.lock"), { recursive: true });
    await mkdir(wsDir, { recursive: true });

    const lockOwner = join(stateDir, "supervisor.lock", "owner");
    await writeFile(lockOwner, "999999");

    const detachedFile = join(stateDir, "detached.pid");
    await writeFile(detachedFile, "999999 123456\n");

    const oldTemp = join(wsDir, "health.json.abc.tmp");
    const freshTemp = join(wsDir, "bindings.json.xyz.tmp");
    const sqliteFile = join(wsDir, "workspace-daemon-lock.sqlite");
    const targetFile = join(stateDir, "keep-target.txt");
    const symlinkTemp = join(stateDir, "linked.tmp");
    await writeFile(oldTemp, "{}");
    await writeFile(freshTemp, "{}");
    await writeFile(sqliteFile, "sqlite");
    await writeFile(targetFile, "keep");
    await symlink(targetFile, symlinkTemp);

    const nowMs = Date.parse("2026-04-01T12:00:00.000Z");
    const staleTime = new Date(nowMs - 20 * 60 * 1000);
    const freshTime = new Date(nowMs - 60 * 1000);
    await utimes(oldTemp, staleTime, staleTime);
    await utimes(freshTemp, freshTime, freshTime);

    const result = await runDoctorCleanup({
      stateDirectory: stateDir,
      coordinatorRunning: false,
      now: () => nowMs,
      isProcessAlive: () => false,
    });

    expect(result.removed).toEqual([
      { path: join(stateDir, "supervisor.lock"), kind: "stale_supervisor_lock" },
      { path: detachedFile, kind: "stale_detached_pid" },
      { path: oldTemp, kind: "stale_temp_file" },
    ]);
    expect(await Bun.file(lockOwner).exists()).toBe(false);
    expect(await Bun.file(detachedFile).exists()).toBe(false);
    expect(await Bun.file(oldTemp).exists()).toBe(false);
    expect(await Bun.file(freshTemp).exists()).toBe(true);
    expect(await Bun.file(sqliteFile).exists()).toBe(true);
    expect(await Bun.file(targetFile).exists()).toBe(true);
  });

  test("skips locks owned by live processes or while coordinator is running", async () => {
    const stateDir = await makeTempDir("coforge-doctor-cleanup-live-");
    await mkdir(join(stateDir, "supervisor.lock"), { recursive: true });
    await writeFile(join(stateDir, "supervisor.lock", "owner"), "4821");
    await writeFile(join(stateDir, "detached.pid"), "4821 123456\n");

    const result = await runDoctorCleanup({
      stateDirectory: stateDir,
      coordinatorRunning: false,
      isProcessAlive: (pid) => pid === 4821,
    });

    expect(result.removed).toEqual([]);
    expect(result.skipped).toHaveLength(2);
    expect(await Bun.file(join(stateDir, "supervisor.lock", "owner")).exists()).toBe(true);
    expect(await Bun.file(join(stateDir, "detached.pid")).exists()).toBe(true);
  });

  test("CLI forwards --cleanup and doctor command re-reads status after cleanup", async () => {
    const calls: Array<{ json: boolean; cleanup?: boolean }> = [];
    const doctor: DoctorCommand = {
      async run(options) {
        calls.push(options);
        return 0;
      },
    };

    await expect(
      runCli(
        ["doctor", "--cleanup", "--json"],
        { login: { async run() {} }, setup: { async run() {} }, doctor },
        { stdout: () => undefined, stderr: () => undefined },
      ),
    ).resolves.toBe(0);
    expect(calls).toEqual([{ json: true, cleanup: true }]);

    let reads = 0;
    let cleaned = false;
    const stdout: string[] = [];
    const command = createDoctorCommand(
      { stdout: (line) => stdout.push(line) },
      async () => {
        reads += 1;
        return cleaned
          ? HEALTHY_STATUS
          : {
              ...HEALTHY_STATUS,
              supervisor: {
                ...HEALTHY_STATUS.supervisor,
                loaded: false,
                rpc: { reachable: false, error: "down" },
              },
              locks: {
                machineMutationLock: "free",
                supervisorLock: { present: true, ownerPid: 999999 },
              },
            };
      },
      {
        runCleanup: async () => {
          cleaned = true;
          return {
            removed: [{ path: "/tmp/supervisor.lock", kind: "stale_supervisor_lock" }],
            skipped: [],
          };
        },
      },
    );

    const exitCode = await command.run({ json: true, cleanup: true });
    expect(exitCode).toBe(0);
    expect(reads).toBe(2);
    const parsed = JSON.parse(stdout[0]!);
    expect(parsed.ok).toBe(true);
    expect(parsed.cleanup).toEqual({
      removed: [{ path: "/tmp/supervisor.lock", kind: "stale_supervisor_lock" }],
      skipped: [],
    });
  });

  test("ignores crash history for disabled workspaces, guards held locks, and handles detached.pid PID reuse", async () => {
    const disabledStatus: ComputerStatusReport = {
      ...HEALTHY_STATUS,
      workspaces: {
        readable: true,
        workspaces: [
          {
            ...(HEALTHY_STATUS.workspaces.readable
              ? HEALTHY_STATUS.workspaces.workspaces[0]!
              : ({} as never)),
            enabled: false,
            running: false,
            pid: null,
            pidSource: null,
            cloudConnection: null,
          },
        ],
      },
    };
    const disabledDoctor = createDoctorReport(disabledStatus, {
      crashHistoryByWorkspace: new Map([["ws-1", { recentCrashes: ["2026-04-01T11:59:50.000Z"] }]]),
    });
    expect(disabledDoctor.checks.find((c) => c.name === "crash-history")).toBeUndefined();

    const stateDir = await makeTempDir("coforge-doctor-cleanup-guards-");
    await mkdir(join(stateDir, "supervisor.lock"), { recursive: true });
    await writeFile(join(stateDir, "detached.pid"), "4821 10000\n");

    const mutationHeld = await runDoctorCleanup({
      stateDirectory: stateDir,
      coordinatorRunning: false,
      machineMutationLock: "held",
      isProcessAlive: () => false,
    });
    expect(mutationHeld.removed).toEqual([]);
    expect(mutationHeld.skipped).toHaveLength(2);

    const lockHeld = await runDoctorCleanup({
      stateDirectory: stateDir,
      coordinatorRunning: false,
      isSupervisorLockHeld: async () => true,
      readProcessStartedAt: async () => 99999,
      platform: "linux",
    });
    expect(lockHeld.removed).toEqual([
      { path: join(stateDir, "detached.pid"), kind: "stale_detached_pid" },
    ]);
    expect(lockHeld.skipped).toEqual([
      {
        path: join(stateDir, "supervisor.lock"),
        reason: "supervisor process lock is actively held",
      },
    ]);
  });
});
