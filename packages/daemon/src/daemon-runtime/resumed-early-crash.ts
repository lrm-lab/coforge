import type { AgentSessionExit } from "@coforge/agent";
import type { AgentRuntimeEvent } from "@lrm/coforge-anvil";

/**
 * A stored native Session that crashes the runtime seconds after every resume is corrupt in a
 * way the provider cannot report (Raft 1.0.63 `noteResumedEarlyCrashClose`): two consecutive
 * qualifying closes mean the daemon invalidates the Session and cold-starts a fresh one rather
 * than letting every wake burn a launch on the same crash.
 *
 * A close qualifies when the launch asked to resume a stored Session, the process exited on its
 * own inside the window, and the provider never produced model output — text, thinking or a tool
 * call — before it died. Daemon-initiated endings (`launch.stopping`, a take-offline, a delivery
 * backoff hold) and fresh/recycled sessions never qualify; any non-qualifying close resets the
 * streak, as does a different Session id.
 *
 * "Exited on its own" is proven by `AgentSession.onExit`'s exit detail, matching Raft's
 * `signal === null && code > 0 && code < 128`: only a self-exit code in 1–127 qualifies. Signal
 * deaths (daemon kills, the OOM killer, an operator's kill), clean exits, exits whose cause the
 * adapter cannot observe and adapters that report no detail at all never qualify. The
 * `launch.stopping` early return stays as a supplementary guard for endings the process owner
 * cannot describe.
 */
export const RESUMED_EARLY_CRASH_WINDOW_MS = 15_000;
export const RESUMED_EARLY_CRASH_FALLBACK_THRESHOLD = 2;

export type ResumedEarlyCrashFacts = Readonly<{
  /** The stored Session this launch asked to resume; undefined for a fresh or recycled launch. */
  resumedSessionId: string | undefined;
  /** The launch created a fresh Session (`sessionMode: "create"`), whatever id it carried. */
  sessionModeCreate: boolean;
  /** Milliseconds since the provider session start was requested. */
  uptimeMs: number;
  /** The provider produced text, thinking or a tool call during this launch. */
  modelOutputObserved: boolean;
  /** A runtime error already took this Agent offline; its own recovery owns the outcome. */
  offline: boolean;
  /** An explicit hold (a retry backoff, a tripped fence) already owns this Agent's deliveries. */
  deliveryHold: boolean;
  /** The daemon itself is stopping; shutdown exits are not crashes. */
  daemonStopping: boolean;
  /** How the provider process ended; undefined when the session reports no detail. */
  exit: AgentSessionExit | undefined;
}>;

export function isResumedEarlyCrashClose(facts: ResumedEarlyCrashFacts): boolean {
  return (
    facts.resumedSessionId !== undefined &&
    !facts.sessionModeCreate &&
    facts.uptimeMs <= RESUMED_EARLY_CRASH_WINDOW_MS &&
    !facts.modelOutputObserved &&
    !facts.offline &&
    !facts.deliveryHold &&
    !facts.daemonStopping &&
    facts.exit !== undefined &&
    facts.exit.signal === null &&
    typeof facts.exit.code === "number" &&
    facts.exit.code > 0 &&
    facts.exit.code < 128
  );
}

/** Per-Agent consecutive qualifying closes, keyed by the Session they resumed. Volatile like the
 * launch state it observes: a daemon restart starts the count over. */
export class ResumedEarlyCrashStreak {
  readonly #streaks = new Map<string, { sessionId: string; count: number }>();

  /** The consecutive count for this Session; a different Session id restarts at 1. */
  note(agentId: string, sessionId: string): number {
    const prior = this.#streaks.get(agentId);
    const count = prior?.sessionId === sessionId ? prior.count + 1 : 1;
    this.#streaks.set(agentId, { sessionId, count });
    return count;
  }

  clear(agentId: string): void {
    this.#streaks.delete(agentId);
  }
}

/** What one launch's `close` needs beyond what the watch itself observed. */
export type ResumedEarlyCrashClose = Omit<
  ResumedEarlyCrashFacts,
  "uptimeMs" | "modelOutputObserved"
> & {
  agentId: string;
  /** The Session to invalidate — the one the server last saw, when it differs from the resumed. */
  staleSessionId: string | undefined;
  streak: ResumedEarlyCrashStreak;
  /** Threshold reached: invalidate the stale Session and cold-start a fresh one. */
  coldStart: (agentId: string, staleSessionId: string) => void;
};

/** One launch's early-crash observation: the clock starts when the provider session is
 * requested, main-session model output disqualifies the close, and `close` applies the streak. */
export class ResumedEarlyCrashWatch {
  readonly #requestedAtMs: number;
  #modelOutputObserved = false;

  constructor(requestedAtMs = Date.now()) {
    this.#requestedAtMs = requestedAtMs;
  }

  /** Main-session model output only: a subagent's work does not prove the resumed Session
   * itself produced anything (Raft's `RATE_LIMIT_BACKOFF_CLEARING_PROGRESS`). */
  observe(event: AgentRuntimeEvent): void {
    if (
      (event.type === "text-delta" ||
        event.type === "thinking-delta" ||
        event.type === "tool-start") &&
      !event.subagent
    )
      this.#modelOutputObserved = true;
  }

  /** The process ended: count a qualifying close, or clear the streak on any other ending. */
  close(input: ResumedEarlyCrashClose): void {
    const { agentId, resumedSessionId, staleSessionId, streak, coldStart, ...facts } = input;
    if (
      resumedSessionId === undefined ||
      staleSessionId === undefined ||
      !isResumedEarlyCrashClose({
        resumedSessionId,
        uptimeMs: Date.now() - this.#requestedAtMs,
        modelOutputObserved: this.#modelOutputObserved,
        ...facts,
      })
    ) {
      streak.clear(agentId);
      return;
    }
    if (streak.note(agentId, resumedSessionId) >= RESUMED_EARLY_CRASH_FALLBACK_THRESHOLD) {
      streak.clear(agentId);
      coldStart(agentId, staleSessionId);
    }
  }
}
