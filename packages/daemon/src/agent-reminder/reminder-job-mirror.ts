import type { ReminderJob, ReminderSync } from "@lrm/coforge-sdk/internal";

/** The version-fenced mirror of the authoritative cloud schedule; it holds jobs, never timers. */
export class ReminderJobMirror {
  readonly #jobs = new Map<string, Map<string, ReminderJob>>();
  readonly #authorized = new Set<string>();
  readonly #versions = new Map<string, number>();
  readonly #tombstones = new Set<string>();
  readonly #changedAfterSnapshot = new Set<string>();

  get(agentId: string, reminderId: string): ReminderJob | undefined {
    return this.#jobs.get(agentId)?.get(reminderId);
  }

  forAgent(agentId: string): Iterable<ReminderJob> {
    return this.#jobs.get(agentId)?.values() ?? [];
  }

  /** Whether a snapshot has synchronised this Agent yet: without one its changes cannot install. */
  authorized(agentId: string): boolean {
    return this.#authorized.has(agentId);
  }

  clear(): void {
    this.#jobs.clear();
    this.#authorized.clear();
  }

  replaceWithSnapshot(sync: ReminderSync): void {
    this.#authorized.add(sync.agentId);
    const previous = this.#jobs.get(sync.agentId) ?? new Map();
    const jobs = new Map<string, ReminderJob>();
    for (const job of sync.jobs) {
      const key = this.#versionKey(sync.agentId, job.reminderId);
      const fence = this.#versions.get(key) ?? -1;
      if (job.version >= fence && !(job.version === fence && this.#tombstones.has(key))) {
        this.#versions.set(key, job.version);
        this.#changedAfterSnapshot.delete(key);
        jobs.set(job.reminderId, job);
      }
    }
    for (const old of previous.values()) {
      const key = this.#versionKey(sync.agentId, old.reminderId);
      if (this.#changedAfterSnapshot.has(key) && !jobs.has(old.reminderId))
        jobs.set(old.reminderId, old);
    }
    this.#jobs.set(sync.agentId, jobs);
  }

  /** The reminder a non-snapshot sync changed and the job to arm for it, or undefined when it is ignored. */
  applyChange(sync: ReminderSync): { reminderId: string; job?: ReminderJob } | undefined {
    if (!this.#authorized.has(sync.agentId)) return;
    const jobs = this.#jobs.get(sync.agentId) ?? new Map();
    const reminderId = sync.operation === "upsert" ? sync.jobs[0]!.reminderId : sync.reminderId!;
    const version = sync.operation === "upsert" ? sync.jobs[0]!.version : sync.version!;
    const key = this.#versionKey(sync.agentId, reminderId);
    const fence = this.#versions.get(key) ?? -1;
    if (version < fence || (version === fence && this.#tombstones.has(key))) return;
    this.#versions.set(key, version);
    this.#changedAfterSnapshot.add(key);
    if (sync.operation === "cancel") this.#tombstones.add(key);
    else this.#tombstones.delete(key);
    if (sync.operation === "upsert") jobs.set(reminderId, sync.jobs[0]!);
    else jobs.delete(reminderId);
    this.#jobs.set(sync.agentId, jobs);
    return { reminderId, job: sync.operation === "upsert" ? sync.jobs[0]! : undefined };
  }

  #versionKey(agentId: string, reminderId: string) {
    return `${agentId}:${reminderId}`;
  }
}
