import type { AgentProcJob } from "@lrm/coforge-sdk/agent";
import { stopVerifiedProcJob } from "#src/platform/proc-job-process";
import { markProcJobExited, toPublicProcJob, type StoredProcJob } from "./proc-job-ledger";
import { ProcJobRssSampler } from "./proc-job-rss-sampler";

export class ProcJobMemoryMonitor {
  readonly #sampler: ProcJobRssSampler;
  #readings = new Map<string, number>();
  #generation = 0;

  constructor(platform: NodeJS.Platform, sampler?: ProcJobRssSampler) {
    this.#sampler = sampler ?? new ProcJobRssSampler({ platform });
  }

  reset(): void {
    this.#generation++;
    this.#readings.clear();
    this.#sampler.reset();
  }

  async sample(jobs: readonly StoredProcJob[]): Promise<StoredProcJob[]> {
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
      this.reset();
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
    const usageBytes = this.#readings.get(job.id);
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
