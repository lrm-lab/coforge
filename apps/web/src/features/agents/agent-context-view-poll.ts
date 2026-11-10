import { pollForAnswer } from "#src/features/computers/poll-for-answer";
import type { AgentContextViewRead } from "#src/server/computers/computer-agent-context-views.server";

/** A restore the Computer finishes quickly answers within a moment. */
export const AGENT_CONTEXT_VIEW_FIRST_POLL_INTERVAL_MS = 250;
/** How often the page asks for the Computer's result once it is taking a while. */
export const AGENT_CONTEXT_VIEW_POLL_INTERVAL_MS = 1_000;
/** Past the Computer's 25 second restore and inside the server's 35 second pending and result
 * lifetime. */
export const AGENT_CONTEXT_VIEW_CLIENT_DEADLINE_MS = 30_000;

/**
 * Asks for a started context view's result until it is no longer pending (`pollForAnswer`).
 * Production closes a request idle for about ten seconds, so the restore is polled for, never
 * awaited in one call. No result by the deadline, or the caller going away, ends as the same
 * `timeout` an advertised Computer that never answers is shown as.
 */
export function awaitAgentContextView(options: {
  read(): Promise<AgentContextViewRead>;
  signal: AbortSignal;
  deadlineMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<Exclude<AgentContextViewRead, { status: "pending" }>> {
  return pollForAnswer({
    ...options,
    onGiveUp: { status: "timeout", reason: "old_daemon" },
    firstIntervalMs: AGENT_CONTEXT_VIEW_FIRST_POLL_INTERVAL_MS,
    intervalMs: AGENT_CONTEXT_VIEW_POLL_INTERVAL_MS,
    deadlineMs: options.deadlineMs ?? AGENT_CONTEXT_VIEW_CLIENT_DEADLINE_MS,
  });
}
