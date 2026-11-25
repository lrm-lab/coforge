import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentAppInbox } from "#src/agent-app-inbox/agent-app-inbox";
import { decodeAgentProcJob } from "@lrm/coforge-sdk/agent";
import { readProcJobMemoryLimit } from "#src/proc-jobs/proc-job-memory-config";
import {
  procJobLedgerPath,
  readProcJobLedger,
  readProcJobLedgerState,
  toPublicProcJob,
  writeProcJobLedger,
  type StoredProcJob,
} from "#src/proc-jobs/proc-job-ledger";
import { ProcJobManager, type ProcJobManagerOptions } from "#src/proc-jobs/proc-job-manager";
import { PROC_JOB_RSS_INTERVAL_MS, ProcJobRssSampler } from "#src/proc-jobs/proc-job-rss-sampler";

const mib = 1024 * 1024;

async function waitFor<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = performance.now() + 3_000;
  do {
    const value = await read();
    if (value !== undefined) return value;
    await Bun.sleep(15);
  } while (performance.now() < deadline);
  throw new Error("Timed out waiting for the proc job");
}

test.each(["existing daemon", "adopted ledger"] as const)(
  "%s stops a sampled job after two readings while preserving its start-time limit",
  async (mode) => {
    if (process.platform !== "darwin" && process.platform !== "linux") return;
    const directory = await mkdtemp(join(tmpdir(), "coforge-proc-enforcement-"));
    const stateDirectory = join(directory, "state");
    const memoryConfigPath = join(directory, "proc.json");
    let targetPgid: number | undefined;
    let readingClock = 0;
    let reads = 0;
    let high = false;
    const rssSampler = new ProcJobRssSampler({
      now: () => readingClock,
      readGroups: async () => {
        reads++;
        if (!targetPgid) return undefined;
        return new Map([
          [
            targetPgid,
            {
              bytes: mib * (high ? 3 : 2),
              members: new Set([targetPgid]),
            },
          ],
        ]);
      },
    });
    const inbox = await AgentAppInbox.open(stateDirectory, "ws", "agent");
    const ledgerPath = procJobLedgerPath(stateDirectory);
    const options = {
      workspaceId: "ws",
      workspaceRoot: directory,
      stateDirectory,
      memoryConfigPath,
      rssSampler,
      publishMemoryNotice: async (owner, item, commit) => {
        const state = await readProcJobLedgerState(ledgerPath);
        expect(owner).toBe("agent");
        expect(state.jobs[0]?.memory?.termination).toBe("memory_limit");
        expect(state.memoryNotices).toEqual([{ agentId: owner, jobId: state.jobs[0]!.id }]);
        await inbox.publishOnce(item, commit);
      },
      sweepIntervalMs: 15,
      graceMs: 100,
      systemdRunAvailable: async () => false,
      systemdMemoryScope: async () => undefined,
      systemdPresentCheck: () => false,
    } satisfies ProcJobManagerOptions;
    let manager = new ProcJobManager(options);
    const request = {
      name: "sampled",
      command: [process.execPath, "-e", "await Bun.sleep(12000)"],
    };
    try {
      await mkdir(join(directory, "ws", "agents", "agent"), { recursive: true });
      await Bun.write(memoryConfigPath, JSON.stringify({ memoryMaxMb: 2 }));
      const { job } = await manager.start({ agentId: "agent", provider: "pi", request });
      expect(job.memory).toEqual({ mode: "process_group_rss", limitBytes: 2 * mib });
      targetPgid = job.pgid!;
      await Bun.write(memoryConfigPath, JSON.stringify({ memoryMaxMb: 8 }));

      const sample = await waitFor(async () => {
        const memory = (await manager.list("agent")).jobs[0]?.memory;
        return memory?.usageBytes === 2 * mib ? memory : undefined;
      });
      expect(sample.limitBytes).toBe(2 * mib);
      const priorReads = reads;
      await manager.list("agent");
      await manager.logs("agent", { name: job.name });
      expect(reads).toBe(priorReads);

      high = true;
      readingClock += PROC_JOB_RSS_INTERVAL_MS;
      const first = await waitFor(async () => {
        const [job] = (await manager.list("agent")).jobs;
        return job?.memory?.usageBytes === 3 * mib ? job : undefined;
      });
      expect(first.status).toBe("running");
      expect(inbox.list()).toEqual([]);
      if (mode === "adopted ledger") {
        manager.close();
        const beforeAdopt = reads;
        manager = new ProcJobManager({ ...options, memoryConfigPath: undefined });
        const adopted = await waitFor(async () => {
          const [record] = (await manager.list("agent")).jobs;
          return reads > beforeAdopt && record?.memory?.usageBytes !== undefined
            ? record
            : undefined;
        });
        expect(adopted).toMatchObject({ status: "running", memory: { limitBytes: 2 * mib } });
      }
      readingClock += PROC_JOB_RSS_INTERVAL_MS;
      const terminal = await waitFor(async () => {
        const job = (await readProcJobLedger(procJobLedgerPath(stateDirectory)))[0];
        return job?.status === "exited" ? job : undefined;
      });
      expect(terminal.memory).toEqual({
        mode: "process_group_rss",
        limitBytes: 2 * mib,
        termination: "memory_limit",
      });
      expect(decodeAgentProcJob(terminal).stopReason).toBe("exited");
      const notices = await waitFor(async () => {
        const state = await readProcJobLedgerState(ledgerPath);
        return state.memoryNotices.length === 0 ? inbox.list() : undefined;
      });
      expect(notices.map((item) => item.itemId)).toEqual([`proc:memory_limit:${job.id}`]);
      expect(await inbox.read()).toHaveLength(1);
      expect(await inbox.read()).toEqual([]);

      if (mode === "adopted ledger") return;
      await Bun.write(memoryConfigPath, JSON.stringify({ memoryMaxMb: -1 }));
      await expect(
        manager.start({ agentId: "agent", provider: "pi", request }),
      ).rejects.toMatchObject({
        status: 400,
      });
      await Bun.write(memoryConfigPath, JSON.stringify({ memoryMaxMb: 0 }));
      const disabled = await manager.start({ agentId: "agent", provider: "pi", request });
      expect(disabled.job.memory).toBeUndefined();
    } finally {
      await manager.stop("agent", { all: true, force: true }).catch(() => {});
      manager.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  15_000,
);

test("local memory config defaults to 4096 MiB and fails closed on invalid bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-proc-memory-config-"));
  const path = join(directory, "proc.json");
  try {
    expect(await readProcJobMemoryLimit(path)).toBe(4096 * mib);
    await Bun.write(path, "{}");
    expect(await readProcJobMemoryLimit(path)).toBe(4096 * mib);
    for (const memoryMaxMb of [0.5, -1, "4", Number.MAX_SAFE_INTEGER]) {
      await Bun.write(path, JSON.stringify({ memoryMaxMb }));
      await expect(readProcJobMemoryLimit(path)).rejects.toMatchObject({ status: 400 });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a selected Linux hard scope that fails verification does not relaunch the user job", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-proc-scope-rejected-"));
  const stateDirectory = join(directory, "state");
  const memoryConfigPath = join(directory, "proc.json");
  const marker = join(directory, "command-ran");
  const manager = new ProcJobManager({
    platform: "linux",
    workspaceId: "ws",
    workspaceRoot: directory,
    stateDirectory,
    memoryConfigPath,
    systemdMemoryScope: async () => ({
      systemdRunPath: "/usr/bin/false",
      systemctlPath: "/usr/bin/false",
      environment: { PATH: "/usr/bin:/bin" },
    }),
  });
  try {
    await mkdir(join(directory, "ws", "agents", "agent"), { recursive: true });
    await expect(
      manager.start({
        agentId: "agent",
        provider: "pi",
        request: {
          command: [process.execPath, "-e", 'await Bun.write(Bun.argv[1], "")', marker],
        },
      }),
    ).rejects.toMatchObject({
      errorCode: "proc_spawn_failed",
      message: expect.stringContaining("Could not verify the scope memory limit"),
    });
    expect(await Bun.file(marker).exists()).toBe(false);
    expect((await manager.list("agent")).jobs).toEqual([]);
  } finally {
    await manager.stop("agent", { all: true, force: true }).catch(() => {});
    manager.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 10_000);

test("capped scope identity is retained privately through a ledger round trip", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-proc-scope-ledger-"));
  try {
    const path = procJobLedgerPath(directory);
    const systemdUnit = "coforge-proc-memory-ledger.scope";
    const record: StoredProcJob = {
      id: "job",
      name: "scope-ledger",
      agentId: "agent",
      workspaceId: "ws",
      pid: 123,
      pgid: 123,
      status: "running",
      startedAt: new Date().toISOString(),
      cwd: directory,
      logPath: join(directory, "job.log"),
      command: ["/bin/true"],
      systemdUnit,
      memory: { mode: "systemd_cgroup", limitBytes: 32 * mib },
      memoryScope: {
        bootId: "98e33974-1087-4277-87bc-01fdd0827554",
        invocationId: "b".repeat(32),
        group: "/user.slice/" + systemdUnit,
        directory: "45:1234",
        rootDirectory: "45:1",
      },
    };
    await writeProcJobLedger(path, [record]);
    const [loaded] = await readProcJobLedger(path);
    expect(loaded).toEqual(record);
    expect(toPublicProcJob(loaded!)).not.toHaveProperty("memoryScope");

    const broken = {
      ...record,
      memoryScope: { ...record.memoryScope!, group: "/scope/../../" + systemdUnit },
    };
    await writeProcJobLedger(path, [broken]);
    const [uncertain] = await readProcJobLedger(path);
    expect(uncertain?.memory?.mode).toBe("systemd_cgroup");
    expect(uncertain?.memoryScope).toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a daemon startup retries a pending notice after its terminal job has been pruned", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-proc-notice-adopt-"));
  const stateDirectory = join(directory, "state");
  const ledgerPath = procJobLedgerPath(stateDirectory);
  const jobId = crypto.randomUUID();
  const agentId = "agent";
  const inbox = await AgentAppInbox.open(stateDirectory, "ws", agentId);
  const recovered = Promise.withResolvers<void>();
  const manager = new ProcJobManager({
    workspaceId: "ws",
    workspaceRoot: directory,
    stateDirectory,
    publishMemoryNotice: async (owner, item, commit) => {
      expect(owner).toBe(agentId);
      await inbox.publishOnce(item, commit);
      recovered.resolve();
    },
  });
  try {
    await writeProcJobLedger(ledgerPath, [], [{ agentId, jobId }]);
    manager.startSweep();
    await recovered.promise;
    expect(await readProcJobLedgerState(ledgerPath)).toEqual({ jobs: [], memoryNotices: [] });
    expect((await inbox.read()).map((item) => item.sourceRef.id)).toEqual([jobId]);
    expect(await inbox.read()).toEqual([]);
  } finally {
    manager.close();
    await rm(directory, { recursive: true, force: true });
  }
});
