import type {
  ReminderSnapshotGeneration,
  ReminderSnapshotOutcome,
  ReminderSnapshotReason,
} from "./runtime-app-inbox-sync";

export type ReminderSnapshotAsksPorts = {
  /** Asks for the Agent's snapshot and applies it; says how that ended. `generation` is the
   * connection the ask belongs to, and a newer one replaces it. */
  requestReminderSnapshot(
    agentId: string,
    reason: ReminderSnapshotReason,
    generation: ReminderSnapshotGeneration,
  ): Promise<ReminderSnapshotOutcome>;
};

/** Every Agent whose reminders matter now: running (idle included) or still launching. */
export function reminderAgentIds(
  agents: { runningAgentIds(): string[] },
  launches: ReadonlyMap<string, unknown>,
): string[] {
  return [...new Set([...agents.runningAgentIds(), ...launches.keys()])];
}

/** The one place an Agent's reminders are asked for: once per Agent and connection however many
 * triggers arrive, and the next connection asks every Agent again. An ask that could not be made
 * releases the Agent for the next trigger. This is also the whole of the coalescing — the changes
 * that arrive meanwhile are kept by the scheduler, not withheld here.
 *
 * A connection is a generation. `connected()` starts a new one and ends the asks of the old one, so
 * a reconnect never leaves a second retry loop for the same Agent running behind the new one. */
export class ReminderSnapshotAsks {
  readonly #asked = new Set<string>();
  #stopped = false;
  /** The connection asks belong to; `connected()` replaces it and aborts the one it replaces. */
  #generation = 0;
  #connection = new AbortController();

  constructor(private readonly ports: ReminderSnapshotAsksPorts) {}

  /** A new connection replaces every answer the old one gave, and every ask still in flight. */
  connected(): void {
    this.#generation++;
    this.#connection.abort();
    this.#connection = new AbortController();
    this.#asked.clear();
  }

  request(agentId: string, reason: ReminderSnapshotReason): void {
    if (this.#stopped || this.#asked.has(agentId)) return;
    this.#asked.add(agentId);
    const askedIn = this.#generation;
    /** Only the connection that made this ask may release the Agent again: an answer from a
     * superseded one must leave the live connection's entry where it is. */
    const release = () => {
      if (askedIn === this.#generation) this.#asked.delete(agentId);
    };
    void this.ports
      .requestReminderSnapshot(agentId, reason, {
        generation: askedIn,
        current: () => this.#generation,
        signal: this.#connection.signal,
      })
      .then((outcome) => {
        // A stopping daemon asks nothing ever again: no log, no retry, no re-armed Agent.
        if (outcome === "stopped") this.#stopped = true;
        else if (outcome === "unavailable") release();
      }, release);
  }
}
