/**
 * Tracks whether an Agent's runtime is inside one provider-reported phase (context compaction, a
 * review pass), independent of which provider reported it. Providers do not decide when a phase
 * started or finished - they relay the raw signal their protocol gives them, edge or not, and
 * this tracker is the single place that turns repeated/partial signals into "report once when it
 * starts, then once when it finishes" (previously duplicated per provider, e.g. Kiro's local
 * `#compacting` de-dup). Which events and Activity each phase has is `./runtime-phases.ts`.
 *
 * The daemon runtime keeps one instance per phase, keyed by agentId (an Agent has at most one
 * active launch's phase of each kind open at a time, matching how the last busy Activity in
 * `daemon-runtime/agent-activity-publisher.ts` is already keyed).
 */

type PhaseState =
  | { kind: "inactive" }
  | { kind: "active"; startedAt: number; watchdog: ReturnType<typeof setTimeout> | undefined };

export type PhaseStartResult = "started" | "already-active";
export type PhaseFinishResult = "finished" | "not-active";
export type PhaseInterruptResult = "interrupted" | "not-active";

export class PhaseTracker {
  readonly #states = new Map<string, PhaseState>();

  /**
   * @param onStale Called at most once per phase, `staleMs` after it started, if it is still
   * active by then. The daemon runtime broadcasts the phase's stale Activity for it (see
   * runtime.ts); without a live launch the notice is dropped - a torn-down Agent never grows a
   * visible Activity.
   */
  constructor(
    private readonly onStale: (agentId: string) => void,
    private readonly staleMs: number,
  ) {}

  /** Starts a phase. A second start while one is already active is a no-op: the caller must
   * not re-announce it, matching the "report once when it starts" contract. */
  start(agentId: string): PhaseStartResult {
    const state = this.#states.get(agentId);
    if (state?.kind === "active") return "already-active";
    const startedAt = Date.now();
    const watchdog = setTimeout(() => this.#markStale(agentId, startedAt), this.staleMs);
    this.#states.set(agentId, { kind: "active", startedAt, watchdog });
    return "started";
  }

  /**
   * Ends a phase, explicit or inferred. A no-op unless one is currently active, so
   * a finish signal with no matching start (or a second finish for the same phase) never
   * produces a visible Activity - the caller only announces "finished" when this returns
   * `"finished"`.
   */
  finish(agentId: string): PhaseFinishResult {
    return this.#deactivate(agentId) ? "finished" : "not-active";
  }

  /** Ends an active phase as interrupted. Like `finish`, a no-op unless one is
   * active, so the caller only reports the interruption when this returns `"interrupted"`. */
  interrupt(agentId: string): PhaseInterruptResult {
    return this.#deactivate(agentId) ? "interrupted" : "not-active";
  }

  isActive(agentId: string): boolean {
    return this.#states.get(agentId)?.kind === "active";
  }

  /** Stops any pending watchdog and forgets this Agent's state. Must run on every launch
   * end/dispose so a torn-down Agent never leaks a timer, and so a later launch starts clean. */
  dispose(agentId: string): void {
    const state = this.#states.get(agentId);
    if (state?.kind === "active") clearTimeout(state.watchdog);
    this.#states.delete(agentId);
  }

  /** Disposes every tracked Agent; used on full daemon shutdown. */
  disposeAll(): void {
    for (const state of this.#states.values())
      if (state.kind === "active") clearTimeout(state.watchdog);
    this.#states.clear();
  }

  #deactivate(agentId: string): boolean {
    const state = this.#states.get(agentId);
    if (!state || state.kind !== "active") return false;
    clearTimeout(state.watchdog);
    this.#states.set(agentId, { kind: "inactive" });
    return true;
  }

  #markStale(agentId: string, startedAt: number): void {
    const state = this.#states.get(agentId);
    // Guards a watchdog from a previous phase firing after a new one has already begun, and a
    // watchdog outliving `finish`/`interrupt`/`dispose` (both already clear the timer, but a
    // timer already queued on the event loop when they ran must still no-op here).
    if (!state || state.kind !== "active" || state.startedAt !== startedAt) return;
    // One-shot: leaves `kind: "active"` so a second stale notice is never re-armed for the same
    // phase; only an explicit/inferred finish or a fresh `start()` changes state from here.
    this.#states.set(agentId, { kind: "active", startedAt, watchdog: undefined });
    this.onStale(agentId);
  }
}
