import type { ReminderSync } from "@lrm/coforge-sdk/internal";

/** What arrived for an Agent that no snapshot has synchronised yet: kept, latest arrival per
 * reminder, until the snapshot that installs it. It keeps only — whether to ask for that snapshot
 * is the caller's business, and asking is coalesced where the asking is done. */
export class UnsyncedReminderChanges {
  readonly #kept = new Map<string, Map<string, ReminderSync>>();

  /** Keeps the change, and names the Agent whose snapshot installs it. */
  remember(sync: ReminderSync): string {
    const reminderId = sync.operation === "upsert" ? sync.jobs[0]!.reminderId : sync.reminderId!;
    const kept = this.#kept.get(sync.agentId) ?? new Map<string, ReminderSync>();
    kept.set(`${sync.agentId}:${reminderId}`, sync);
    this.#kept.set(sync.agentId, kept);
    return sync.agentId;
  }

  /** The changes to install, in arrival order, and whatever the next unsynchronised run keeps. */
  take(agentId: string): ReminderSync[] {
    const kept = [...(this.#kept.get(agentId)?.values() ?? [])];
    this.#kept.delete(agentId);
    return kept;
  }

  clear(): void {
    this.#kept.clear();
  }
}
