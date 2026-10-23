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

  observe(): void {
    this.#lastEventAtMs = Date.now();
  }

  /** Input that starts a turn (a notice to an idle Agent) restarts the clock, as in the reference
   * client: a turn is never judged by the quiet spell before it began. */
  noteTurnStarted(): void {
    this.#lastEventAtMs = Date.now();
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
  silentForMs: number;
  /** A tool call is running: a long build or test is silent until it ends. */
  hasOpenToolCall: boolean;
  /** The session reported a native session id the relaunch can resume. */
  resumable: boolean;
}>;

/**
 * Whether a message arriving now should restart the Agent's provider instead of being steered
 * into its turn: the turn has been silent for `STALLED_RECOVERY_SILENCE_MS`, nothing it is waiting
 * on is still running, and the restart can resume the same session.
 */
export function shouldRecoverStalledRuntime(facts: StalledRecoveryFacts): boolean {
  return (
    facts.turnBusy &&
    facts.silentForMs >= STALLED_RECOVERY_SILENCE_MS &&
    !facts.hasOpenToolCall &&
    facts.resumable
  );
}
