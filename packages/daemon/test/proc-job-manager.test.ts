import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROC_EXITED_KEPT_PER_AGENT,
  PROC_JOB_LEDGER_FILE,
  PROC_MAX_JOBS_PER_AGENT,
  type AgentProcJob,
} from "@lrm/coforge-sdk/agent";
import { listMachineRunningProcJobs, stopMachineRunningProcJobs } from "@lrm/coforge-daemon";
import { AGENT_LAUNCH_TAG_ENV } from "#src/platform/agent-launch-tag";
import { sweepAgentLaunchTags } from "#src/platform/agent-launch-tag-sweep";
import { ProcJobError } from "#src/proc-jobs/proc-job-error";
import { rotateProcLogIfNeeded } from "#src/proc-jobs/proc-job-logs";
import { ProcJobManager } from "#src/proc-jobs/proc-job-manager";
import { workspaceStateDirectory } from "#src/supervisor/workspace-instance";

const tempRoot = await mkdtemp(join(tmpdir(), "coforge-proc-manager-"));
const cleanupPids = new Set<number>();
const managers: ProcJobManager[] = [];

afterEach(async () => {
  for (const manager of managers.splice(0)) manager.close();
  for (const pid of cleanupPids) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  cleanupPids.clear();
});

afterAll(() => rm(tempRoot, { recursive: true, force: true }));

function createManager(
  overrides: {
    workspaceId?: string;
    workspaceRoot?: string;
    stateDirectory?: string;
    platform?: NodeJS.Platform;
    maxJobsPerAgent?: number;
    exitedKeptPerAgent?: number;
    maxLogBytes?: number;
    graceMs?: number;
    killWaitMs?: number;
  } = {},
) {
  const workspaceId = overrides.workspaceId ?? "workspace-a";
  const workspaceRoot = overrides.workspaceRoot ?? join(tempRoot, `ws-${crypto.randomUUID()}`);
  const stateDirectory = overrides.stateDirectory ?? join(tempRoot, `state-${crypto.randomUUID()}`);
  const manager = new ProcJobManager({
    workspaceId,
    workspaceRoot,
    stateDirectory,
    sweepIntervalMs: 60_000,
    ...overrides,
  });
  managers.push(manager);
  return { manager, workspaceId, workspaceRoot, stateDirectory };
}

async function prepareAgentWorkspace(
  workspaceRoot: string,
  workspaceId: string,
  agentId: string,
): Promise<string> {
  const dir = join(workspaceRoot, workspaceId, "agents", agentId);
  await mkdir(dir, { recursive: true });
  return dir;
}

function trackJobPid(job: AgentProcJob): AgentProcJob {
  cleanupPids.add(job.pid);
  return job;
}

describe("ProcJobManager", () => {
  test("starts a detached job, auto-derives unique names, reads bounded logs, and replaces exited jobs", async () => {
    const { manager, workspaceId, workspaceRoot } = createManager();
    await prepareAgentWorkspace(workspaceRoot, workspaceId, "agent-a");

    const first = await manager.start({
      agentId: "agent-a",
      provider: "pi",
      request: {
        command: [
          process.execPath,
          "-e",
          "console.log('line-1'); console.log('line-2'); setInterval(() => {}, 1000);",
        ],
      },
    });
    trackJobPid(first.job);
    expect(first.job.status).toBe("running");
    expect(first.job.name).toBe("bun");
    expect(first.job.pgid).toBe(first.job.pid);

    const logDirStat = lstatSync(
      join(workspaceRoot, workspaceId, "agents", "agent-a", "proc-logs"),
    );
    expect(logDirStat.mode & 0o777).toBe(0o700);

    const second = await manager.start({
      agentId: "agent-a",
      provider: "pi",
      request: {
        command: [process.execPath, "-e", "setInterval(() => {}, 1000);"],
      },
    });
    trackJobPid(second.job);
    expect(second.job.name).toBe("bun-2");

    await expect(
      manager.start({
        agentId: "agent-a",
        provider: "pi",
        request: { name: "bun", command: [process.execPath, "-e", ""] },
      }),
    ).rejects.toMatchObject({ errorCode: "proc_name_exists", status: 409 });

    let logs = await manager.logs("agent-a", { name: "bun", tail: 10 });
    for (let attempt = 0; attempt < 40 && !logs.content.includes("line-2"); attempt++) {
      await Bun.sleep(25);
      logs = await manager.logs("agent-a", { name: "bun", tail: 10 });
    }
    expect(logs.content).toContain("line-1");
    expect(logs.content).toContain("line-2");
    expect(logs.rotated).toBe(false);

    const tailOne = await manager.logs("agent-a", { name: "bun", tail: 1 });
    expect(tailOne.content).toBe("line-2\n");

    const inc = await manager.logs("agent-a", { name: "bun", offset: logs.nextOffset });
    expect(inc.content).toBe("");
    expect(inc.nextOffset).toBe(logs.nextOffset);

    await manager.stop("agent-a", { name: "bun" }, "agent_stop");
    await manager.stop("agent-a", { all: true }, "agent_stop");

    const replaced = await manager.start({
      agentId: "agent-a",
      provider: "pi",
      request: { name: "bun", command: [process.execPath, "-e", "console.log('fresh');"] },
    });
    trackJobPid(replaced.job);
    expect(replaced.replacedExited).toBe(true);
  });

  test("enforces per-agent running cap of 8 and prunes oldest exited jobs", async () => {
    const { manager, workspaceId, workspaceRoot } = createManager();
    await prepareAgentWorkspace(workspaceRoot, workspaceId, "agent-a");

    for (let i = 0; i < PROC_MAX_JOBS_PER_AGENT; i++) {
      const started = await manager.start({
        agentId: "agent-a",
        provider: "codex",
        request: {
          name: `srv-${i}`,
          command: [process.execPath, "-e", "setInterval(() => {}, 1000);"],
        },
      });
      trackJobPid(started.job);
    }

    let caught: unknown;
    try {
      await manager.start({
        agentId: "agent-a",
        provider: "codex",
        request: {
          name: "srv-overflow",
          command: [process.execPath, "-e", "setInterval(() => {}, 1000);"],
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProcJobError);
    expect((caught as ProcJobError).errorCode).toBe("proc_limit");
    expect((caught as ProcJobError).status).toBe(409);
    expect((caught as ProcJobError).jobs?.length).toBe(PROC_MAX_JOBS_PER_AGENT);

    await manager.stop("agent-a", { all: true, force: true }, "agent_stop");

    for (let i = 0; i < PROC_EXITED_KEPT_PER_AGENT + 3; i++) {
      const started = await manager.start({
        agentId: "agent-a",
        provider: "codex",
        request: {
          name: `short-${i}`,
          command: [process.execPath, "-e", "process.exit(0);"],
        },
      });
      trackJobPid(started.job);
      for (let wait = 0; wait < 40; wait++) {
        const listed = await manager.list("agent-a");
        if (listed.jobs.find((j) => j.name === `short-${i}`)?.status === "exited") break;
        await Bun.sleep(25);
      }
    }

    const listed = await manager.list("agent-a");
    expect(listed.jobs.length).toBe(PROC_EXITED_KEPT_PER_AGENT);
    expect(
      existsSync(join(workspaceRoot, workspaceId, "agents", "agent-a", "proc-logs", "short-0.log")),
    ).toBe(false);
  });

  test("validates cwd, spawn errors, platform support, and runtime restrictions", async () => {
    const { manager, workspaceId, workspaceRoot } = createManager();
    const agentDir = await prepareAgentWorkspace(workspaceRoot, workspaceId, "agent-a");
    await mkdir(join(agentDir, "subdir"), { recursive: true });
    writeFileSync(join(agentDir, "not-a-dir"), "x");

    const sub = await manager.start({
      agentId: "agent-a",
      provider: "claude-code",
      request: {
        name: "in-subdir",
        cwd: "subdir",
        command: [
          process.execPath,
          "-e",
          "console.log(process.cwd()); setInterval(() => {}, 1000);",
        ],
      },
    });
    trackJobPid(sub.job);
    expect(sub.job.cwd).toBe(join(agentDir, "subdir"));
    await manager.stop("agent-a", { name: "in-subdir", force: true });

    await expect(
      manager.start({
        agentId: "agent-a",
        provider: "claude-code",
        request: { cwd: "missing-dir", command: [process.execPath, "-e", ""] },
      }),
    ).rejects.toMatchObject({ errorCode: "proc_invalid_request", status: 400 });

    await expect(
      manager.start({
        agentId: "agent-a",
        provider: "claude-code",
        request: { cwd: "not-a-dir", command: [process.execPath, "-e", ""] },
      }),
    ).rejects.toMatchObject({ errorCode: "proc_invalid_request", status: 400 });

    await expect(
      manager.start({
        agentId: "agent-a",
        provider: "claude-code",
        request: { command: ["/nonexistent/coforge-missing-bin"] },
      }),
    ).rejects.toMatchObject({ errorCode: "proc_spawn_failed", status: 500 });

    await expect(
      manager.start({
        agentId: "agent-a",
        provider: "unknown-provider",
        request: { command: [process.execPath, "-e", ""] },
      }),
    ).rejects.toMatchObject({ errorCode: "proc_runtime_restricted", status: 403 });

    const winManager = createManager({ platform: "win32" }).manager;
    await expect(
      winManager.start({
        agentId: "agent-a",
        provider: "pi",
        request: { command: [process.execPath, "-e", ""] },
      }),
    ).rejects.toMatchObject({ errorCode: "proc_unsupported", status: 501 });
  });

  test("sanitizes transient CoForge env vars and survives launch-tag sweep", async () => {
    const prevContext = process.env.COFORGE_AGENT_CONTEXT;
    const prevTag = process.env[AGENT_LAUNCH_TAG_ENV];
    const prevDaemonHome = process.env.COFORGE_DAEMON_HOME;
    process.env.COFORGE_AGENT_CONTEXT = "secret-ctx";
    process.env[AGENT_LAUNCH_TAG_ENV] = "agent-a:launch-token-1";
    process.env.COFORGE_DAEMON_HOME = "/tmp/daemon-home";

    try {
      const { manager, workspaceId, workspaceRoot } = createManager();
      await prepareAgentWorkspace(workspaceRoot, workspaceId, "agent-a");

      const started = await manager.start({
        agentId: "agent-a",
        provider: "pi",
        agentEnvVars: { FROM_AGENT: "agent-val" },
        request: {
          name: "env-check",
          env: { FROM_JOB: "job-val" },
          command: [
            process.execPath,
            "-e",
            "console.log(JSON.stringify({ ctx: process.env.COFORGE_AGENT_CONTEXT ?? null, tag: process.env.COFORGE_AGENT_LAUNCH_TAG ?? null, daemon: process.env.COFORGE_DAEMON_HOME ?? null, a: process.env.FROM_AGENT, j: process.env.FROM_JOB })); setInterval(() => {}, 1000);",
          ],
        },
      });
      trackJobPid(started.job);

      let logs = await manager.logs("agent-a", { name: "env-check" });
      for (
        let i = 0;
        i < 40 && !logs.content.includes("FROM_JOB") && !logs.content.includes("job-val");
        i++
      ) {
        await Bun.sleep(25);
        logs = await manager.logs("agent-a", { name: "env-check" });
      }
      expect(JSON.parse(logs.content.trim())).toEqual({
        ctx: null,
        tag: null,
        daemon: null,
        a: "agent-val",
        j: "job-val",
      });

      const sweep = await sweepAgentLaunchTags({
        agentId: "agent-a",
        trigger: "test",
      });
      expect(sweep.killed).toBe(0);
      const afterSweep = await manager.list("agent-a");
      expect(afterSweep.jobs.find((j) => j.name === "env-check")?.status).toBe("running");

      await manager.stop("agent-a", { name: "env-check", force: true });
    } finally {
      if (prevContext === undefined) delete process.env.COFORGE_AGENT_CONTEXT;
      else process.env.COFORGE_AGENT_CONTEXT = prevContext;
      if (prevTag === undefined) delete process.env[AGENT_LAUNCH_TAG_ENV];
      else process.env[AGENT_LAUNCH_TAG_ENV] = prevTag;
      if (prevDaemonHome === undefined) delete process.env.COFORGE_DAEMON_HOME;
      else process.env.COFORGE_DAEMON_HOME = prevDaemonHome;
    }
  });

  test("rotates oversized log files and signals offset reset cleanly", async () => {
    const { manager, workspaceId, workspaceRoot } = createManager();
    await prepareAgentWorkspace(workspaceRoot, workspaceId, "agent-a");
    const started = await manager.start({
      agentId: "agent-a",
      provider: "pi",
      request: {
        name: "noisy",
        command: [
          process.execPath,
          "-e",
          "console.log('A'.repeat(400)); console.log('B'.repeat(400)); setInterval(() => {}, 1000);",
        ],
      },
    });
    trackJobPid(started.job);

    let logs = await manager.logs("agent-a", { name: "noisy" });
    for (let i = 0; i < 40 && !logs.content.includes("BBBB"); i++) {
      await Bun.sleep(25);
      logs = await manager.logs("agent-a", { name: "noisy" });
    }
    const previousOffset = logs.nextOffset;
    expect(previousOffset).toBeGreaterThan(800);

    const rotated = await rotateProcLogIfNeeded(started.job.logPath, 500);
    expect(rotated).toBe(true);
    expect(existsSync(`${started.job.logPath}.1`)).toBe(true);
    expect(readFileSync(started.job.logPath, "utf8")).toBe("");

    const afterRotate = await manager.logs("agent-a", {
      name: "noisy",
      offset: previousOffset,
    });
    expect(afterRotate.rotated).toBe(true);
    expect(afterRotate.nextOffset).toBe(0);
    await manager.stop("agent-a", { name: "noisy", force: true });
  });

  test("escalates SIGTERM to SIGKILL and guards against PID reuse", async () => {
    const { manager, workspaceId, workspaceRoot, stateDirectory } = createManager({
      graceMs: 150,
      killWaitMs: 1_000,
    });
    await prepareAgentWorkspace(workspaceRoot, workspaceId, "agent-a");

    const stubborn = await manager.start({
      agentId: "agent-a",
      provider: "pi",
      request: {
        name: "stubborn",
        command: [
          process.execPath,
          "-e",
          "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);",
        ],
      },
    });
    trackJobPid(stubborn.job);
    for (let i = 0; i < 40; i++) {
      const l = await manager.logs("agent-a", { name: "stubborn" });
      if (l.content.includes("ready")) break;
      await Bun.sleep(25);
    }

    const stopped = await manager.stop("agent-a", { name: "stubborn" }, "owner_stop");
    expect(stopped.stopped).toHaveLength(1);
    expect(stopped.stopped[0]?.status).toBe("exited");
    expect(stopped.stopped[0]?.stopReason).toBe("owner_stop");

    const innocent = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000);"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    cleanupPids.add(innocent.pid);

    const ledgerPath = join(stateDirectory, PROC_JOB_LEDGER_FILE);
    const foreignLedger = {
      version: 1,
      jobs: [
        {
          id: "foreign-1",
          agentId: "agent-a",
          workspaceId,
          name: "reused-pid",
          command: ["node"],
          cwd: workspaceRoot,
          pid: innocent.pid,
          pgid: innocent.pid,
          startIdentity: "mismatch-identity-value",
          status: "running",
          startedAt: new Date().toISOString(),
          logPath: join(
            workspaceRoot,
            workspaceId,
            "agents",
            "agent-a",
            "proc-logs",
            "reused-pid.log",
          ),
        },
      ],
    };
    writeFileSync(ledgerPath, JSON.stringify(foreignLedger));
    chmodSync(ledgerPath, 0o600);

    const managerReloaded = new ProcJobManager({
      workspaceId,
      workspaceRoot,
      stateDirectory,
      sweepIntervalMs: 60_000,
    });
    managers.push(managerReloaded);
    const stopForeign = await managerReloaded.stop("agent-a", { name: "reused-pid" });
    expect(stopForeign.alreadyExited).toEqual(["reused-pid"]);
    expect(() => process.kill(innocent.pid, 0)).not.toThrow();
    innocent.kill("SIGKILL");
  });

  test("survives manager.close() and supports restart adoption plus machine listing/stopping", async () => {
    const coordState = join(tempRoot, `coord-${crypto.randomUUID()}`);
    const wsId = "ws-e2e";
    const wsState = workspaceStateDirectory(coordState, wsId);
    const wsRoot = join(tempRoot, `wsroot-${crypto.randomUUID()}`);
    await prepareAgentWorkspace(wsRoot, wsId, "agent-1");

    const m1 = createManager({
      workspaceId: wsId,
      workspaceRoot: wsRoot,
      stateDirectory: wsState,
    }).manager;
    const started = await m1.start({
      agentId: "agent-1",
      provider: "pi",
      request: {
        name: "daemon-survivor",
        command: [process.execPath, "-e", "console.log('alive'); setInterval(() => {}, 1000);"],
      },
    });
    trackJobPid(started.job);
    m1.close();

    expect(() => process.kill(started.job.pid, 0)).not.toThrow();

    const machineListed = await listMachineRunningProcJobs(coordState);
    expect(machineListed.map((entry) => ({ name: entry.name, pid: entry.pid }))).toEqual([
      { name: "daemon-survivor", pid: started.job.pid },
    ]);

    const m2 = createManager({
      workspaceId: wsId,
      workspaceRoot: wsRoot,
      stateDirectory: wsState,
    }).manager;
    const listedAfterRestart = await m2.list("agent-1");
    expect(listedAfterRestart.jobs[0]?.status).toBe("running");
    expect(listedAfterRestart.jobs[0]?.pid).toBe(started.job.pid);

    const stoppedMachine = await stopMachineRunningProcJobs(coordState, {
      workspaceId: wsId,
      force: true,
    });
    expect(stoppedMachine.stopped.length).toBe(1);

    const afterStop = await listMachineRunningProcJobs(coordState);
    expect(afterStop).toEqual([]);
    m2.close();

    const m3 = createManager({
      workspaceId: wsId,
      workspaceRoot: wsRoot,
      stateDirectory: wsState,
    }).manager;
    const migratedTarget = await m3.start({
      agentId: "agent-1",
      provider: "pi",
      request: {
        name: "mig-srv",
        command: [process.execPath, "-e", "setInterval(() => {}, 1000);"],
      },
    });
    trackJobPid(migratedTarget.job);
    const migStopped = await m3.stopAllForAgent("agent-1", "migrated", { force: true });
    expect(migStopped.stopped[0]?.stopReason).toBe("migrated");

    const ghostLedgerPath = join(wsState, PROC_JOB_LEDGER_FILE);
    const deadRecord = {
      version: 1,
      jobs: [
        {
          ...migratedTarget.job,
          agentId: "agent-1",
          workspaceId: wsId,
          pid: 999_999_991,
          status: "running",
        },
      ],
    };
    const serialized = JSON.stringify(deadRecord);
    writeFileSync(ghostLedgerPath, serialized);
    expect(await listMachineRunningProcJobs(coordState)).toEqual([]);
    expect(readFileSync(ghostLedgerPath, "utf8")).toBe(serialized);
    m3.close();
  });

  test("refuses symlinked log files without following them", async () => {
    const { manager, workspaceId, workspaceRoot } = createManager();
    const agentDir = await prepareAgentWorkspace(workspaceRoot, workspaceId, "agent-a");
    const logDir = join(agentDir, "proc-logs");
    await mkdir(logDir, { recursive: true, mode: 0o700 });
    const targetFile = join(agentDir, "sensitive.txt");
    writeFileSync(targetFile, "keep");
    symlinkSync(targetFile, join(logDir, "bad-link.log"));

    await expect(
      manager.start({
        agentId: "agent-a",
        provider: "pi",
        request: {
          name: "bad-link",
          command: [process.execPath, "-e", "console.log('pwn');"],
        },
      }),
    ).rejects.toThrow();
    expect(readFileSync(targetFile, "utf8")).toBe("keep");
  });
});
