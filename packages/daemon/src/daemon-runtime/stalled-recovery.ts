import { foldUntrustedLine, truncateCodePoints } from "@lrm/coforge-sdk/internal";
import { PROCESS_TREE_EXIT_GRACE_MS } from "@lrm/coforge-anvil";
import { processClockMs } from "#src/platform/process-tree";

const LAST_STEP_MAX_CHARS = 200;

/**
 * How long a busy turn's provider may stay silent before a new message restarts it, as in the
 * reference client (its `RUNTIME_PROGRESS_STALE_MS`).
 */
export const STALLED_RECOVERY_SILENCE_MS = 15 * 60_000;

/**
 * The longer fuse for a session that cannot take input into a turn already in progress (its
 * `steersBusyTurn` is not true): its `NON_STDIN_ALIVE_RECOVERY_MS`. A waiting
 * message has no path to such a provider anyway, so a quiet turn is weaker evidence of a hang —
 * and a restart cannot deliver any sooner than the queued input's own next turn would.
 */
export const STALLED_RECOVERY_SILENCE_QUEUE_ONLY_MS = 60 * 60_000;

/** How long a stalled provider gets to exit before its restart counts as failed: an in-process
 * provider's disposal waits on the very prompt that hangs. Long enough for both rungs of the
 * cleanup ladder — the polite stop's grace and the forced kill's, `PROCESS_TREE_EXIT_GRACE_MS`
 * each — plus room for the kills themselves; a shorter deadline would fire before the forced
 * kill and report a failure that the ladder was about to fix (task #726). */
export const STALLED_RECOVERY_EXIT_TIMEOUT_MS = 2 * PROCESS_TREE_EXIT_GRACE_MS + 5_000;

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
  /** A retryable failure's backoff currently holds this Agent's deliveries — a rate limit waiting
   * for its reported reset, or another retryable error waiting out its delay. Nothing about a
   * restart shortens that wait. This blocks only the two judgments about *waiting* work: a queued
   * delivery whose turn never began, and a notice taken but never acted on. A turn that is
   * actually running is judged on its own silence: a hold may exist while such a turn is still
   * in flight, and a genuinely hung one must stay recoverable. */
  recoveryHold?: boolean;
  /** The running session's `steersBusyTurn` declaration: input sent mid-turn reaches the model
   * inside that turn. A queue-only session's silent busy turn is judged against
   * `STALLED_RECOVERY_SILENCE_QUEUE_ONLY_MS` instead of `STALLED_RECOVERY_SILENCE_MS`. */
  steersBusyTurn: boolean;
}>;

/**
 * Whether a message waiting for this Agent means its provider should be restarted instead of
 * waiting: either the turn it is in has been silent past its fuse — `STALLED_RECOVERY_SILENCE_MS`
 * for a provider that steers a live turn, `STALLED_RECOVERY_SILENCE_QUEUE_ONLY_MS` for one that
 * can only queue input behind it — or the
 * delivery was admitted but no turn ever started, with nothing still running and a session the
 * restart can resume. Both are the same recovery path; the second only covers the queued message
 * that never got a turn (the sweep already requires one to be waiting).
 */
export function shouldRecoverStalledRuntime(facts: StalledRecoveryFacts): boolean {
  const silenceLimitMs = facts.steersBusyTurn
    ? STALLED_RECOVERY_SILENCE_MS
    : STALLED_RECOVERY_SILENCE_QUEUE_ONLY_MS;
  const silentTurnStalled = facts.turnBusy && facts.silentForMs >= silenceLimitMs;
  // A retryable failure's backoff is a planned wait, not a stall (Raft's
  // `queueDeliveriesForRuntimeErrorBackoff`): nothing about a restart shortens it.
  const queuedTurnNeverStarted =
    !facts.recoveryHold &&
    !facts.turnBusy &&
    !facts.liveTurn &&
    (facts.queuedForMs ?? 0) >= STALLED_RECOVERY_SILENCE_MS;
  // A notice the process took and then did nothing about for the whole stall window — the
  // accepted-noticed-but-frozen case (task #318). The action must be *older than the notice*: an
  // Agent that acted after taking it has answered, and being idle since is not being frozen.
  const noticeAcceptedForMs = facts.noticeAcceptedForMs ?? 0;
  const noticedButFrozen =
    !facts.recoveryHold &&
    !facts.turnBusy &&
    !facts.liveTurn &&
    noticeAcceptedForMs >= STALLED_RECOVERY_SILENCE_MS &&
    (facts.lastAgentActionForMs ?? Number.POSITIVE_INFINITY) > noticeAcceptedForMs;
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
