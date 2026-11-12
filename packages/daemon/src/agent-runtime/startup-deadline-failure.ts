/** What a person can do when every attempt to start the Agent used up the wake deadline: their
 * page's Activity and the Computer log are the two places that name a cause (task #33). */
export const STARTUP_DEADLINE_EXCEEDED_DETAIL =
  "Every attempt to start this Agent used up the startup deadline before the runtime was ready, " +
  "so it never came up. Start it by hand from its page, then check `coforge-computer logs` on " +
  "this Computer for what the runtime was doing.";

/**
 * The failure a wake gives up with. No single attempt names it: the attempts themselves are what
 * ran out (`assemble-exited-delivery.ts`'s `giveUpWake`, task #32's deadline). `code` is
 * `LAUNCH_FAILURE_REASON.STARTUP_DEADLINE_EXCEEDED` — kept as a literal here because
 * `launch-failure.ts` is at its size gate, and a test pins the two together. The numbers are what
 * the give-up log reports beside it.
 */
export class AgentStartupDeadlineExceededError extends Error {
  readonly code = "startup_deadline_exceeded";
  constructor(
    readonly attempts: number,
    readonly deadlineMs: number,
    readonly elapsedMs: number,
  ) {
    super(`Agent startup deadline exceeded after ${attempts} attempt(s)`);
    this.name = "AgentStartupDeadlineExceededError";
  }
}
