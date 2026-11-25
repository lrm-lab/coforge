import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeAgentProcJob } from "@lrm/coforge-sdk/agent";
import { readProcJobMemoryLimit } from "#src/proc-jobs/proc-job-memory-config";
import { procJobLedgerPath, readProcJobLedger } from "#src/proc-jobs/proc-job-ledger";
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
    const options = {
      workspaceId: "ws",
      workspaceRoot: directory,
      stateDirectory,
      memoryConfigPath,
      rssSampler,
      sweepIntervalMs: 15,
      graceMs: 100,
      systemdRunAvailable: async () => false,
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
