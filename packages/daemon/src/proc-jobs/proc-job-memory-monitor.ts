import type { AgentProcJob } from "@lrm/coforge-sdk/agent";
import { stopVerifiedProcJob } from "#src/platform/proc-job-process";
import { readProcJobMemoryScopeUsage } from "#src/platform/proc-job-systemd-scope";
import { markProcJobExited, toPublicProcJob, type StoredProcJob } from "./proc-job-ledger";
import { PROC_JOB_RSS_INTERVAL_MS, ProcJobRssSampler } from "./proc-job-rss-sampler";

export class ProcJobMemoryMonitor {
  readonly #sampler: ProcJobRssSampler;
  readonly #platform: NodeJS.Platform;
  #readings = new Map<string, number>();
  #scopeReadings = new Map<string, number>();
  #scopeSampleAt = -Infinity;
  #scopeReadingsAt = -Infinity;
  #scopeSampling = false;
  #generation = 0;

  constructor(platform: NodeJS.Platform, sampler?: ProcJobRssSampler) {
    this.#platform = platform;
    this.#sampler = sampler ?? new ProcJobRssSampler({ platform });
  }

  reset(): void {
    this.#generation++;
    this.#readings.clear();
    this.#scopeReadings.clear();
    this.#scopeSampleAt = -Infinity;
    this.#sampler.reset();
  }

  async #sampleScopes(jobs: readonly StoredProcJob[]): Promise<void> {
    if (this.#platform !== "linux" || this.#scopeSampling) return;
    const scopes = jobs.filter(
      (job) => job.status === "running" && job.memory?.mode === "systemd_cgroup" && job.memoryScope,
    );
    if (scopes.length === 0) {
      this.#scopeReadings.clear();
      this.#scopeSampleAt = -Infinity;
      return;
    }
    const now = performance.now();
    if (now - this.#scopeSampleAt < PROC_JOB_RSS_INTERVAL_MS - 1) return;
    this.#scopeSampleAt = now;
    this.#scopeSampling = true;
    const generation = this.#generation;
    const readings = new Map<string, number>();
    const deadline = now + 3_000;
    try {
      for (let offset = 0; offset < scopes.length; offset += 16) {
        if (generation !== this.#generation) return;
        if (performance.now() >= deadline) break;
        await Promise.all(
          scopes.slice(offset, offset + 16).map(async (job) => {
            const bytes = await readProcJobMemoryScopeUsage(job, this.#platform);
            if (bytes !== undefined) readings.set(job.id, bytes);
          }),
        );
      }
      if (generation === this.#generation) {
        this.#scopeReadings = performance.now() >= deadline ? new Map() : readings;
        this.#scopeReadingsAt = now;
      }
    } finally {
      this.#scopeSampling = false;
    }
  }

  async sample(jobs: readonly StoredProcJob[]): Promise<StoredProcJob[]> {
    void this.#sampleScopes(jobs).catch(() => {});
    const candidates = jobs.flatMap((job) => {
      if (
        job.status !== "running" ||
        !job.groupAnchor ||
        !job.startIdentity ||
        job.memory?.mode !== "process_group_rss"
      )
        return [];
      return [
        {
          id: job.id,
          pid: job.pid,
          pgid: job.pgid,
          groupAnchor: job.groupAnchor,
          startIdentity: job.startIdentity,
          groupAnchorBootId: job.groupAnchorBootId,
          limitBytes: job.memory.limitBytes,
        },
      ];
    });
    if (!candidates.length) {
      this.#readings.clear();
      this.#sampler.reset();
      return [];
    }
    const generation = this.#generation;
    const readings = await this.#sampler.sample(candidates);
    if (generation !== this.#generation || !readings) return [];
    this.#readings = new Map(
      readings.flatMap(({ id, bytes }) => (bytes === undefined ? [] : [[id, bytes]])),
    );
    const exceeded = new Set(
      readings.filter((reading) => reading.overLimit).map((reading) => reading.id),
    );
    return jobs.filter((job) => exceeded.has(job.id));
  }

  toPublic(record: StoredProcJob): AgentProcJob {
    const job = toPublicProcJob(record);
    const scoped = job.memory?.mode === "systemd_cgroup";
    if (scoped && performance.now() - this.#scopeReadingsAt >= 2 * PROC_JOB_RSS_INTERVAL_MS)
      return job;
    const readings = scoped ? this.#scopeReadings : this.#readings;
    const usageBytes = readings.get(job.id);
    if (job.status !== "running" || job.memory === undefined || usageBytes === undefined)
      return job;
    return { ...job, memory: { ...job.memory, usageBytes } };
  }
}

export async function settleProcJobMemoryStop(
  target: StoredProcJob,
  options: { platform: NodeJS.Platform; graceMs: number; killWaitMs: number },
): Promise<StoredProcJob> {
  const outcome = await stopVerifiedProcJob(target, { ...options, requireDeliveredSignal: true });
  const { memoryStopRequested: _requested, ...job } = target;
  if (outcome === "failed") return job;
  const exited = markProcJobExited(job, "exited");
  return outcome === "stopped" && exited.memory
    ? { ...exited, memory: { ...exited.memory, termination: "memory_limit" } }
    : exited;
}
