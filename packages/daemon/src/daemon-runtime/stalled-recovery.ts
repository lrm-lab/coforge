import { foldUntrustedLine, truncateCodePoints } from "@lrm/coforge-sdk/internal";
import { processClockMs } from "#src/platform/process-tree";

const LAST_STEP_MAX_CHARS = 200;

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

  #lastCompletedAtMs: number | undefined;

  observe(event?: Readonly<{ type: string }>): void {
    this.#lastEventAtMs = Date.now();
    if (event?.type === "completed") this.#lastCompletedAtMs = this.#lastEventAtMs;
  }

  /** When this launch last finished a turn; undefined until it does. */
  get lastCompletedAtMs(): number | undefined {
    return this.#lastCompletedAtMs;
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
  /** How long since the Agent's process last accepted an inbox notice; undefined when none was
   * ever accepted. The clock for "took the notice but never acted" (task #318). */
  noticeAcceptedForMs?: number;
  /** How long since the Agent last did anything the daemon can see: a checked read, an
   * operation, or provider output. The three silences share this one clock — any still fresh
   * means the Agent is working. */
  lastAgentActionForMs?: number;
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
  // A notice the process took, followed by the stall window with no checked read, no operation
  // and no provider output at all — the accepted-noticed-but-frozen case (task #318). Any of
  // the three still fresh is a working Agent.
  const noticedButFrozen =
    !facts.turnBusy &&
    !facts.liveTurn &&
    (facts.noticeAcceptedForMs ?? 0) >= STALLED_RECOVERY_SILENCE_MS &&
    (facts.lastAgentActionForMs ?? 0) >= STALLED_RECOVERY_SILENCE_MS;
  return (
    (silentTurnStalled || queuedTurnNeverStarted || noticedButFrozen) &&
    !facts.hasOpenToolCall &&
    facts.resumable
  );
}

/** How many times in a row a stalled turn is restarted with no message waiting for it (task
 * #404). Past this the owner is told and the Agent is left alone until a message arrives or
 * someone restarts it: a turn that hangs again every time is not helped by more restarts. */
export const UNATTENDED_RECOVERY_LIMIT = 2;

/** What an unattended recovery may do now: restart, report the limit (once), or nothing. */
export type UnattendedRecoveryAdmission = "restart" | "limit" | "held";


/** The first turn of a relaunch no message asked for: where the old turn stopped, and to go on
 * from there. */
export function unattendedResumePrompt(silentForMs: number, lastStep: string | undefined): string {
  const minutes = Math.max(1, Math.round(silentForMs / 60_000));
  // Activity text can quote a command or a provider message: one line, bounded (task #336).
  const text = truncateCodePoints(foldUntrustedLine(lastStep ?? ""), LAST_STEP_MAX_CHARS);
  const step = text ? ` Its last reported step was: ${text}.` : "";
  return `[CoForge notice: Your previous turn produced no output for ${minutes} minutes, so CoForge restarted your runtime and resumed this session.${step} No new message is waiting. Continue the work you were doing from where it stopped: check its current state first instead of repeating finished steps. If it was waiting on something that cannot finish, tell whoever asked for the work.]`;
}
