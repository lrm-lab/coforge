import type { ReminderSnapshotReason } from "./runtime-app-inbox-sync";

export type ReminderSnapshotAsksPorts = {
  /** Applies the snapshot it returns; false when no snapshot could be had within its retries. */
  requestReminderSnapshot(agentId: string, reason: ReminderSnapshotReason): Promise<boolean>;
};

/** Every Agent whose reminders matter now: running (idle included) or still launching. */
export function reminderAgentIds(
  agents: { runningAgentIds(): string[] },
  launches: ReadonlyMap<string, unknown>,
): string[] {
  return [...new Set([...agents.runningAgentIds(), ...launches.keys()])];
}

/** Asks at most once per Agent and connection, so a burst of triggers asks once and the next
 * connection asks every Agent again. A failed ask releases the Agent for the next trigger. */
export class ReminderSnapshotAsks {
  readonly #asked = new Set<string>();

  constructor(private readonly ports: ReminderSnapshotAsksPorts) {}

  /** A new connection replaces every answer the old one gave. */
  connected(): void {
    this.#asked.clear();
  }

  request(agentId: string, reason: ReminderSnapshotReason): void {
    if (this.#asked.has(agentId)) return;
    this.#asked.add(agentId);
    void this.ports.requestReminderSnapshot(agentId, reason).then(
      (applied) => {
        if (!applied) this.#asked.delete(agentId);
      },
      () => this.#asked.delete(agentId),
    );
  }
}
