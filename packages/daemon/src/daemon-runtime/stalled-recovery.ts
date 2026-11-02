import { processClockMs } from "#src/platform/process-tree";

/**
 * How long a busy turn's provider may stay silent before a new message restarts it, as in the
 * reference client (its `RUNTIME_PROGRESS_STALE_MS`).
 */
export const STALLED_RECOVERY_SILENCE_MS = 15 * 60_000;

/** How long a stalled provider gets to exit before its restart counts as failed: an in-process
 * provider's disposal waits on the very prompt that hangs. */
export const STALLED_RECOVERY_EXIT_TIMEOUT_MS = 10_000;

/**
 * One launch's provider progress: when the provider last reported any event. Only raw provider
 * events count — never a published Activity, which the busy heartbeat repeats without any
 * progress. Its open tool calls are the launch's `ToolCallLedger`.
 */
export class ProviderProgress {
  #lastEventAtMs = Date.now();
  #turnStartedAtMs = this.#lastEventAtMs;
  #turnStartedProcessClockMs: number;

  constructor(private readonly processClock: () => number = processClockMs) {
    this.#turnStartedProcessClockMs = processClock();
  }

  observe(): void {
    this.#lastEventAtMs = Date.now();
  }

  /** Input that starts a turn (a notice to an idle Agent) restarts the clock, as in the reference
   * client: a turn is never judged by the quiet spell before it began. */
  noteTurnStarted(): void {
    this.#lastEventAtMs = Date.now();
    this.#turnStartedAtMs = this.#lastEventAtMs;
    this.#turnStartedProcessClockMs = this.processClock();
  }

  get turnStartedAtMs(): number {
    return this.#turnStartedAtMs;
  }

  /** The turn's start on the host process clock: the turn-scoped kill fences children by it. */
  get turnStartedProcessClockMs(): number {
    return this.#turnStartedProcessClockMs;
  }

  /** When the provider last reported anything. */
  get lastEventAtMs(): number {
    return this.#lastEventAtMs;
  }

  silentForMs(): number {
    return Date.now() - this.#lastEventAtMs;
  }
}

export type StalledRecoveryFacts = Readonly<{
  /** The launch's turn is busy and its session still reports a live turn. */
  turnBusy: boolean;
  /** The session reports a live turn, whether or not the delivery path sees it as busy. A
   * waiting delivery whose submitted turn never began reports no live turn at all. */
  liveTurn: boolean;
  silentForMs: number;
  /** How long the oldest queued delivery has waited; undefined when nothing is queued. This is
   * the clock for a delivery whose turn never began — an idle provider that just received its
   * first message is not stalled, however quiet it was before. */
  queuedForMs?: number;
  /** A tool call is running: a long build or test is silent until it ends. */
  hasOpenToolCall: boolean;
  /** The session reported a native session id the relaunch can resume. */
  resumable: boolean;
}>;

/**
 * Whether a message waiting for this Agent means its provider should be restarted instead of
 * waiting: either the turn it is in has been silent for `STALLED_RECOVERY_SILENCE_MS`, or the
 * delivery was admitted but no turn ever started, with nothing still running and a session the
 * restart can resume. Both are the same recovery path; the second only covers the queued message
 * that never got a turn (the sweep already requires one to be waiting).
 */
export function shouldRecoverStalledRuntime(facts: StalledRecoveryFacts): boolean {
  const silentTurnStalled = facts.turnBusy && facts.silentForMs >= STALLED_RECOVERY_SILENCE_MS;
  const queuedTurnNeverStarted =
    !facts.turnBusy && !facts.liveTurn && (facts.queuedForMs ?? 0) >= STALLED_RECOVERY_SILENCE_MS;
  return (silentTurnStalled || queuedTurnNeverStarted) && !facts.hasOpenToolCall && facts.resumable;
}
