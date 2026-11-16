import type { ReminderSync } from "@lrm/coforge-sdk/internal";

/** What arrived for an Agent that no snapshot has synchronised yet: kept until the snapshot that
 * installs it, and asked for once per Agent however many changes arrive. */
export class UnsyncedReminderChanges {
  readonly #kept = new Map<string, Map<string, ReminderSync>>();
  readonly #asked = new Set<string>();

  /** Keeps the change, latest arrival per reminder; true when its snapshot still has to be asked. */
  remember(sync: ReminderSync): boolean {
    const reminderId = sync.operation === "upsert" ? sync.jobs[0]!.reminderId : sync.reminderId!;
    const kept = this.#kept.get(sync.agentId) ?? new Map<string, ReminderSync>();
    kept.set(`${sync.agentId}:${reminderId}`, sync);
    this.#kept.set(sync.agentId, kept);
    if (this.#asked.has(sync.agentId)) return false;
    this.#asked.add(sync.agentId);
    return true;
  }

  /** The changes to install, in arrival order, and whatever the next unsynchronised run keeps. */
  take(agentId: string): ReminderSync[] {
    const kept = [...(this.#kept.get(agentId)?.values() ?? [])];
    this.#kept.delete(agentId);
    this.#asked.delete(agentId);
    return kept;
  }

  clear(): void {
    this.#kept.clear();
    this.#asked.clear();
  }
}
