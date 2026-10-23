import { AgentSessionRecoveryError, type AgentRuntimeEvent } from "#src/code-agent/contract";

/** The first turn when no real Message or explicit resume prompt is available. Standing
 * instructions already live in the provider's native system/developer prompt. */
export function agentStartupInput(resuming: boolean): string {
  return [
    resuming
      ? "You are back online. No new messages are pending."
      : "You are starting a fresh session. No new messages are pending.",
    resuming
      ? "Use your existing session context first. If it does not establish your current work, read MEMORY.md and notes/active-context.md if present, and check unfinished tasks assigned to you once."
      : "To recover your work without previous session context, read MEMORY.md and notes/active-context.md if present, and check unfinished tasks assigned to you once.",
    "Use only tools allowed by your role and skip unsupported recovery steps.",
    "Resume only actionable work already requested or assigned to you; do not invent work or scan unrelated channels and projects.",
    "If no actionable work remains, end this turn silently. Do not send a startup announcement or repeat your introduction.",
  ].join(" ");
}

/** Summary-only recovery is bounded catch-up, not an instruction to drain every inbox. */
export function agentStartupCatchupInput(rows: readonly string[], fenced = false): string {
  const command = fenced
    ? "message_read with the exact target"
    : "\`coforge message read --target <target>\`";
  const check = fenced ? "message_check" : "\`coforge message check\`";
  const reading = fenced
    ? "with no before/after/around anchor, continuing while hasNewer is true"
    : "once, retrying only a failed read";
  return `[CoForge inbox notice:
${rows.join("\n")}
Read each listed conversation with ${command} ${reading}, then end this turn. Do not call ${check} in this catch-up mode. Continue working only if you find a direct request, assignment, personal mention, review request, or task addressed to you. Otherwise do not send a reply.]`;
}
export const AGENT_STARTUP_TIMEOUT_MS = 120_000;

/** Launch-local startup judgement. Transport/session bookkeeping is not evidence that the model
 * can work; any other event, a bare `error` included, closes the startup window, and later
 * silence belongs to the ordinary runtime liveness policy, not this timer. Once the model has
 * responded to an input (an outcome, real work, or a provider usage or rate limit), a model error
 * takes the ordinary runtime-error path. Startup fails only at the timeout, or when a startup or
 * recovery input is rejected before a response to it or with `AgentSessionRecoveryError`. */
export class AgentStartup {
  #timer: ReturnType<typeof setTimeout> | undefined;
  readonly #ready = Promise.withResolvers<void>();
  #closed = false;
  #responses = 0;
  #errorObserved = false;

  constructor(onTimeout: () => void) {
    void this.#ready.promise.catch(() => {});
    this.#timer = setTimeout(onTimeout, AGENT_STARTUP_TIMEOUT_MS);
    this.#timer.unref?.();
  }

  /** Settle launch input at native admission or actual readiness, whichever happens first. A
   * rejection before readiness propagates for the caller to judge with `endsLaunch`. */
  run(input: Promise<void>): Promise<void> {
    return Promise.race([input, this.#ready.promise]);
  }

  get waiting(): boolean {
    return this.#timer !== undefined;
  }

  /** A provider `error` event already reported its own runtime error Activity. */
  get errorObserved(): boolean {
    return this.#errorObserved;
  }

  /** Responses observed so far; read before presenting an input to judge its rejection. */
  get responses(): number {
    return this.#responses;
  }

  /** Whether a rejected startup or recovery input ends the launch. Session recovery always does,
   * so the Start retries with a fresh session; any other rejection, only when the model gave no
   * response since `since` (the `responses` read before presenting that input). */
  endsLaunch(error: unknown, since: number): boolean {
    return error instanceof AgentSessionRecoveryError || this.#responses === since;
  }

  /** Track readiness and response for the launch's lifetime, after the timer clears too; a
   * disposed or failed startup ignores events. */
  observe(event: AgentRuntimeEvent): void {
    if (
      this.#closed ||
      event.type === "session" ||
      event.type === "usage" ||
      event.type === "context-usage" ||
      event.type === "progress" ||
      event.type === "reconnecting" ||
      event.type === "notice-undelivered" ||
      (event.type === "activity" &&
        (event.activity.detailKind === "starting" ||
          event.activity.detailKind === "model_request_started" ||
          event.activity.detailKind === "runtime_progress"))
    )
      return;
    this.#clearTimer();
    if (event.type === "error") {
      this.#errorObserved = true;
      if (event.providerLimit === undefined) return;
    }
    this.#responses++;
    // A failed outcome leaves the input to settle the queue, so its rejection is still judged.
    if (event.type !== "completed" || event.status !== "failed") this.#ready.resolve();
  }

  dispose(): void {
    this.#closed = true;
    this.#clearTimer();
    this.#ready.reject(new Error("Agent runtime is stopping"));
  }

  #clearTimer(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /** Claim the timeout only while startup still owns the turn: any event after the deadline was
   * armed already closed it. */
  fail(error: Error): boolean {
    if (this.#timer === undefined) return false;
    this.#closed = true;
    this.#clearTimer();
    this.#ready.reject(error);
    return true;
  }
}
