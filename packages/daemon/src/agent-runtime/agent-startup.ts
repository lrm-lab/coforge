import type { AgentRuntimeEvent } from "#src/code-agent/contract";

/** The first turn when no real Message or explicit resume prompt is available. Standing
 * instructions already live in the provider's native system/developer prompt. */
export function agentStartupInput(resuming: boolean): string {
  return resuming
    ? "You are back online. No new messages are pending. End this turn without taking action."
    : "Start.";
}

/** Summary-only recovery is bounded catch-up, not an instruction to drain every inbox. */
export function agentStartupCatchupInput(totalCount: number, rows: readonly string[]): string {
  return `[CoForge inbox notice (restart recovery):
Inbox update: ${totalCount} message${totalCount === 1 ? "" : "s"} delivered or held for you
${rows.join("\n")}
Read each listed conversation with \`coforge message read --target <target>\` once, retrying only a failed read, then end this turn. Do not call \`coforge message check\` in this catch-up mode. Continue working only if you find a direct request, assignment, personal mention, review request, or task addressed to you. Otherwise do not send a reply.]`;
}
export const AGENT_STARTUP_TIMEOUT_MS = 120_000;

/** Launch-local readiness. Transport/session bookkeeping is not evidence that the model can
 * work. A real turn observation or outcome closes the startup window; later silence belongs
 * to the ordinary runtime liveness policy, not this timer. */
export class AgentStartup {
  #timer: ReturnType<typeof setTimeout> | undefined;
  readonly #ready = Promise.withResolvers<void>();
  #inputAccepted = false;
  #failure: Error | undefined;

  constructor(onTimeout: () => void) {
    void this.#ready.promise.catch(() => {});
    this.#timer = setTimeout(onTimeout, AGENT_STARTUP_TIMEOUT_MS);
    this.#timer.unref?.();
  }

  /** Settle launch input at native admission or actual readiness, whichever happens first.
   * A provider's typed rejection before either is preserved for session recovery. */
  run(input: Promise<void>): Promise<void> {
    return Promise.race([
      input.then(() => {
        this.#inputAccepted = true;
        if (this.#failure) throw this.#failure;
      }),
      this.#ready.promise,
    ]);
  }

  get failureObserved(): boolean {
    return this.#failure !== undefined;
  }

  get waiting(): boolean {
    return this.#timer !== undefined;
  }

  /** Message recovery and user resume prompts use their existing admission/ACK path. */
  admitted(): boolean {
    this.#inputAccepted = true;
    return this.waiting && this.failureObserved;
  }

  /** True when an already-admitted startup failed before the model became ready. */
  observe(event: AgentRuntimeEvent): boolean {
    if (this.#timer === undefined) return false;
    if (
      (event.type === "error" && !event.retryable) ||
      (event.type === "completed" && event.status === "failed") ||
      (event.type === "activity" && event.activity.level === "error")
    ) {
      this.#failure ??= new Error(
        event.type === "error" ? event.message : "Agent startup turn failed",
      );
      return this.#inputAccepted;
    }
    if (
      event.type === "session" ||
      event.type === "usage" ||
      event.type === "context-usage" ||
      event.type === "progress" ||
      event.type === "reconnecting" ||
      event.type === "notice-undelivered"
    )
      return false;
    if (event.type === "error") return false;
    if (
      event.type === "activity" &&
      (event.activity.detailKind === "starting" || event.activity.detailKind === "runtime_progress")
    )
      return false;
    this.#clearTimer();
    this.#ready.resolve();
    return false;
  }

  dispose(): void {
    this.#clearTimer();
    this.#ready.reject(new Error("Agent runtime is stopping"));
  }

  #clearTimer(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /** Claim failure only while startup still owns the turn. An input promise may reject much
   * later, after real work already established readiness; that is an ordinary runtime error. */
  fail(error: Error): boolean {
    if (this.#timer === undefined) return false;
    this.#clearTimer();
    this.#ready.reject(error);
    return true;
  }
}
