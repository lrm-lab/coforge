import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonRuntime, InMemoryDaemonCredentialStore } from "@lrm/coforge-daemon";
import { DaemonConnectionRefusedError } from "#src/connection/daemon-connection-refused-error";
import { sanitizeProcJobEnvironment } from "#src/proc-jobs/proc-job-environment";
import { launchAgentProcJob } from "#src/proc-jobs/proc-job-launch";
import { procJobLedgerPath, writeProcJobLedger } from "#src/proc-jobs/proc-job-ledger";
import { readProcJobLogSlice, rotateProcLogIfNeeded } from "#src/proc-jobs/proc-job-logs";
import { ProcJobManager } from "#src/proc-jobs/proc-job-manager";
import {
  isVerifiedProcJobAlive,
  readProcJobIdentity,
  spawnDetachedProcJob,
} from "#src/platform/proc-job-process";
import { sessionSpy } from "./fixtures/session-spy";
import { emptyCodeAgentDiscovery } from "./fixtures/code-agent-discovery";

const tempRoot = realpathSync(await mkdtemp(join(tmpdir(), "coforge-proc-edge-")));
const cleanupPids = new Set<number>();

afterEach(() => {
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

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("proc job edge cases and lifecycle purge", () => {
  test("sanitizeProcJobEnvironment enriches minimal launchd PATH while keeping jobEnv PATH first", () => {
    const baseEnv = { PATH: "/usr/bin:/bin", HOME: tempRoot };
    const enriched = sanitizeProcJobEnvironment({
      provider: "pi",
      baseEnv,
      jobEnv: { PATH: "/custom/tools", PORT: "4100" },
    });
    expect(enriched.PORT).toBe("4100");
    expect(enriched.PATH?.startsWith("/custom/tools:")).toBe(true);
    expect(enriched.PATH).toContain(
      process.platform === "darwin" ? "/opt/homebrew/bin" : "/usr/local/bin",
    );
  });

  test("spawnDetachedProcJob with systemdUnit validates relative ./script against cwd", async () => {
    const workDir = join(tempRoot, `cwd-${crypto.randomUUID()}`);
    await mkdir(workDir, { recursive: true });
    const scriptPath = join(workDir, "run.sh");
    await writeFile(scriptPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const logPath = join(tempRoot, `log-${crypto.randomUUID()}.log`);
    await writeFile(logPath, "", { mode: 0o600 });

    const error = await spawnDetachedProcJob({
      command: ["./run.sh"],
      cwd: workDir,
      // Use a nonexistent PATH so `systemd-run` is never launched even on Linux, while `./run.sh`
      // is still validated against `cwd` without using PATH.
      env: { PATH: "/nonexistent" },
      logPath,
      systemdUnit: "coforge-proc-test.scope",
      onExit: () => {},
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("run.sh");

    const missingError = await spawnDetachedProcJob({
      command: ["./missing.sh"],
      cwd: workDir,
      env: { PATH: "/nonexistent" },
      logPath,
      systemdUnit: "coforge-proc-test-missing.scope",
      onExit: () => {},
    }).catch((err: unknown) => err);

    expect(missingError).toBeInstanceOf(Error);
    expect(String(missingError)).toContain("missing.sh");
  });

  test("readProcJobLogSlice and rotateProcLogIfNeeded refuse symlinks and keep active log on backup failure", async () => {
    const dir = join(tempRoot, `logs-${crypto.randomUUID()}`);
    await mkdir(dir, { recursive: true });
    const target = join(dir, "secret.txt");
    await writeFile(target, "SECRET_TOKEN\n");
    const linkLog = join(dir, "linked.log");
    await symlink(target, linkLog);

    await expect(readProcJobLogSlice(linkLog, { tail: 10 })).rejects.toThrow("symlink");

    const activeLog = join(dir, "active.log");
    const victim = join(dir, "victim.txt");
    await writeFile(activeLog, "line\n".repeat(40), { mode: 0o600 });
    await writeFile(victim, "preserve-me\n");
    await symlink(victim, `${activeLog}.1`);

    const rotated = await rotateProcLogIfNeeded(activeLog, 40);
    expect(rotated).toBe(false);
    expect((await stat(activeLog)).size).toBeGreaterThan(40);
    expect(await readFile(victim, "utf8")).toBe("preserve-me\n");
  });

  test("isVerifiedProcJobAlive requires startIdentity and launchAgentProcJob fails closed without identity", async () => {
    const check = await isVerifiedProcJobAlive({ pid: process.pid });
    expect(check.alive).toBe(false);

    const workspaceRoot = join(tempRoot, `launch-${crypto.randomUUID()}`);
    const workspaceId = "ws-launch";
    const agentId = "agent-launch";
    const agentDir = join(workspaceRoot, workspaceId, "agents", agentId);
    await mkdir(agentDir, { recursive: true });

    await expect(
      launchAgentProcJob({
        agentId,
        workspaceId,
        workspaceRoot,
        platform: process.platform,
        provider: "pi",
        request: {
          command: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
          name: "no-id",
        },
        existingJobs: [],
        maxJobsPerAgent: 8,
        systemdRunAvailable: async () => false,
        systemdPresentCheck: () => false,
        onLateExit: () => {},
        readIdentity: async () => null,
      } as Parameters<typeof launchAgentProcJob>[0]),
    ).rejects.toThrow("verify process identity");
  });

  test("DaemonRuntime purges surviving proc jobs and ledger on workspace_deleted connection refusal", async () => {
    const workspaceRoot = join(tempRoot, `ws-del-${crypto.randomUUID()}`);
    const stateDir = join(tempRoot, `state-del-${crypto.randomUUID()}`);
    const workspaceId = "ws-del";
    const agentId = "agent-a";
    const agentDir = join(workspaceRoot, workspaceId, "agents", agentId);
    await mkdir(agentDir, { recursive: true });

    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(workspaceId, "computer-a", "token-a");

    const logPath = join(agentDir, "proc-logs", "bg.log");
    await mkdir(join(agentDir, "proc-logs"), { recursive: true });
    await writeFile(logPath, "", { mode: 0o600 });

    const spawned = await spawnDetachedProcJob({
      command: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      cwd: agentDir,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      logPath,
      onExit: () => {},
    });
    cleanupPids.add(spawned.pid);
    const identity = await readProcJobIdentity(spawned.pid);
    expect(identity).not.toBeNull();

    const ledgerPath = procJobLedgerPath(stateDir);
    await writeProcJobLedger(ledgerPath, [
      {
        id: crypto.randomUUID(),
        agentId,
        workspaceId,
        name: "bg",
        command: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
        cwd: agentDir,
        pid: spawned.pid,
        pgid: identity?.pgid ?? spawned.pid,
        startIdentity: identity!.startIdentity,
        status: "running",
        startedAt: new Date().toISOString(),
        logPath,
      },
    ]);

    let onRefused: ((reason: "workspace_deleted") => void) | undefined;
    const runtime = new DaemonRuntime(
      { computerId: "computer-a", workspaceId, workspaceRoot },
      () => ({
        provider: "pi",
        createAgentSession: async () => sessionSpy(),
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          onConnectionRefused(cb) {
            onRefused = cb as (reason: "workspace_deleted") => void;
            return () => {};
          },
        }),
      },
      undefined,
      emptyCodeAgentDiscovery as never,
      stateDir,
    );

    await runtime.start({ computerId: "computer-a", workspaceId, workspaceRoot });
    expect(onRefused).toBeDefined();
    onRefused!("workspace_deleted");

    for (let i = 0; i < 60 && (pidAlive(spawned.pid) || existsSync(ledgerPath)); i++) {
      await Bun.sleep(25);
    }
    expect(pidAlive(spawned.pid)).toBe(false);
    expect(existsSync(ledgerPath)).toBe(false);
    await runtime.stop().catch(() => {});
  });

  test("DaemonRuntime.start purges surviving proc jobs when startup ready fails with workspace_deleted", async () => {
    const workspaceRoot = join(tempRoot, `ws-ref-${crypto.randomUUID()}`);
    const stateDir = join(tempRoot, `state-ref-${crypto.randomUUID()}`);
    const workspaceId = "ws-ref";
    const agentId = "agent-a";
    const agentDir = join(workspaceRoot, workspaceId, "agents", agentId);
    await mkdir(agentDir, { recursive: true });

    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(workspaceId, "computer-a", "token-a");

    const logPath = join(agentDir, "proc-logs", "bg.log");
    await mkdir(join(agentDir, "proc-logs"), { recursive: true });
    await writeFile(logPath, "", { mode: 0o600 });

    const spawned = await spawnDetachedProcJob({
      command: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      cwd: agentDir,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      logPath,
      onExit: () => {},
    });
    cleanupPids.add(spawned.pid);
    const identity = await readProcJobIdentity(spawned.pid);
    const ledgerPath = procJobLedgerPath(stateDir);
    await writeProcJobLedger(ledgerPath, [
      {
        id: crypto.randomUUID(),
        agentId,
        workspaceId,
        name: "bg",
        command: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
        cwd: agentDir,
        pid: spawned.pid,
        pgid: identity?.pgid ?? spawned.pid,
        startIdentity: identity!.startIdentity,
        status: "running",
        startedAt: new Date().toISOString(),
        logPath,
      },
    ]);

    const runtime = new DaemonRuntime(
      { computerId: "computer-a", workspaceId, workspaceRoot },
      () => ({
        provider: "pi",
        createAgentSession: async () => sessionSpy(),
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {
            throw new DaemonConnectionRefusedError("workspace_deleted");
          },
          async stop() {},
        }),
      },
      undefined,
      emptyCodeAgentDiscovery as never,
      stateDir,
    );

    await expect(
      runtime.start({ computerId: "computer-a", workspaceId, workspaceRoot }),
    ).rejects.toThrow(DaemonConnectionRefusedError);
    expect(pidAlive(spawned.pid)).toBe(false);
    expect(existsSync(ledgerPath)).toBe(false);
    await runtime.stop().catch(() => {});
  });

  test("DaemonRuntime.start eagerly adopts proc ledger and reconciles exited jobs without proc RPCs", async () => {
    const workspaceRoot = join(tempRoot, `ws-eager-${crypto.randomUUID()}`);
    const stateDir = join(tempRoot, `state-eager-${crypto.randomUUID()}`);
    const workspaceId = "ws-eager";
    const agentDir = join(workspaceRoot, workspaceId, "agents", "agent-a");
    await mkdir(agentDir, { recursive: true });

    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(workspaceId, "computer-a", "token-a");

    const ledgerPath = procJobLedgerPath(stateDir);
    await writeProcJobLedger(ledgerPath, [
      {
        id: crypto.randomUUID(),
        agentId: "agent-a",
        workspaceId,
        name: "stale-bg",
        command: ["node"],
        cwd: agentDir,
        pid: 999_999_999,
        pgid: 999_999_999,
        startIdentity: "dead-identity",
        status: "running",
        startedAt: new Date().toISOString(),
        logPath: join(agentDir, "proc-logs", "stale-bg.log"),
      },
    ]);

    const runtime = new DaemonRuntime(
      { computerId: "computer-a", workspaceId, workspaceRoot },
      () => ({
        provider: "pi",
        createAgentSession: async () => sessionSpy(),
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
        }),
      },
      undefined,
      emptyCodeAgentDiscovery as never,
      stateDir,
    );

    await runtime.start({ computerId: "computer-a", workspaceId, workspaceRoot });
    let reconciled = await readFile(ledgerPath, "utf8");
    for (let i = 0; i < 40 && !reconciled.includes('"exited"'); i++) {
      await Bun.sleep(25);
      reconciled = await readFile(ledgerPath, "utf8");
    }
    expect(reconciled).toContain('"status":"exited"');
    await runtime.stop().catch(() => {});
  });

  test("purgeWorkspace drains in-flight start() calls, stops newly spawned children, and leaves no ledger", async () => {
    const workspaceRoot = join(tempRoot, `ws-race-${crypto.randomUUID()}`);
    const stateDir = join(tempRoot, `state-race-${crypto.randomUUID()}`);
    const workspaceId = "ws-race";
    const agentId = "agent-a";
    const agentDir = join(workspaceRoot, workspaceId, "agents", agentId);
    await mkdir(agentDir, { recursive: true });

    const inIdentity = Promise.withResolvers<void>();
    const releaseIdentity = Promise.withResolvers<void>();
    let observedPid = 0;

    const manager = new ProcJobManager({
      workspaceId,
      workspaceRoot,
      stateDirectory: stateDir,
      sweepIntervalMs: 60_000,
      readIdentity: async (pid, platform) => {
        observedPid = pid;
        cleanupPids.add(pid);
        inIdentity.resolve();
        await releaseIdentity.promise;
        return readProcJobIdentity(pid, platform);
      },
    } as ConstructorParameters<typeof ProcJobManager>[0]);

    const startPromise = manager.start({
      agentId,
      provider: "pi",
      request: {
        name: "raced-job",
        command: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      },
    });
    await inIdentity.promise;
    const purgePromise = manager.purgeWorkspace();
    releaseIdentity.resolve();

    await expect(startPromise).rejects.toThrow("Workspace has been removed");
    await purgePromise;
    expect(observedPid).toBeGreaterThan(0);
    expect(pidAlive(observedPid)).toBe(false);
    expect(existsSync(procJobLedgerPath(stateDir))).toBe(false);
    expect(existsSync(join(agentDir, "proc-logs", "raced-job.log"))).toBe(false);
  });
});
