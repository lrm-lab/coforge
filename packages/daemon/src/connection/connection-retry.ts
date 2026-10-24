export const RECONNECT_READY_RETRY_MS = 1_000;
export const RECONNECT_READY_RETRY_MAX_MS = 60_000;
/** Consecutive ready failures after which this stops being a transient hiccup: the connection is
 * up and the Workspace is not recovered, so no Agent on this machine can be reached. Reached in
 * about half a minute of backoff. */
export const READY_RETRY_ESCALATE_AFTER = 5;
/** Once escalated, how often to repeat the error rather than logging all of them — at the capped
 * delay this is roughly every ten minutes. */
export const RETRY_ESCALATE_EVERY = 10;
/** Consecutive failed connect attempts after which the outage stops being a blip: with the
 * client's jittered backoff (500 ms doubling to 20 s) that is about a minute offline. */
export const CONNECT_RETRY_ESCALATE_AFTER = 8;
/** After a give-up disconnect the daemon connects the client again itself, doubling from this
 * delay up to the cap, the same shape as the reference Computer's reconnect. */
export const RESUME_CONNECT_MS = 1_000;
export const RESUME_CONNECT_MAX_MS = 30_000;
/** How long a connection must stay up after its ready was accepted before an outage counts as
 * over. A connection dropped sooner (an oversized frame, a 3503 right after ready) continues the
 * same outage, so its backoff keeps growing and its log escalates instead of starting over. */
export const STABLE_CONNECTION_MS = 60_000;

/** A run of failed connect attempts: how many, since when, and how many of them were the
 * daemon's own reconnects after the client gave up (those set the resume delay). */
export type ConnectOutage = { failures: number; sinceMs: number; resumes: number };

/** Whether the `attempt`-th consecutive failure is logged as an error: the first one at
 * `escalateAfter`, then every `RETRY_ESCALATE_EVERY`-th, so a long outage stays visible
 * without an error per attempt. */
export function escalates(attempt: number, escalateAfter: number): boolean {
  return (
    attempt >= escalateAfter && (attempt === escalateAfter || attempt % RETRY_ESCALATE_EVERY === 0)
  );
}

/** The server's own name for the ready step that failed, when its rejection carries one.
 *
 * Only this exact shape is accepted, and only the stage token is kept: a rejection message is
 * remote text, and the log must not become a place arbitrary server output is echoed. Anything else
 * yields nothing, leaving the error code as the only detail — the behaviour before servers said
 * which stage failed. */
export function readyFailureStage(error: unknown): string | undefined {
  const message =
    error && typeof error === "object" && "message" in error ? String(error.message) : "";
  return /^daemon ready failed at ([a-z_]{1,40})$/.exec(message)?.[1];
}
