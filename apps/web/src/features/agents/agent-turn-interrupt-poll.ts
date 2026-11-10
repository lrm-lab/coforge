import type {
  AgentTurnInterruptOutcome,
  AgentTurnInterruptRead,
  AgentTurnInterruptStart,
} from "#src/server/agents/agent-turn-interrupt.server";
import { pollForAnswer } from "#src/features/computers/poll-for-answer";

/** An interrupt that the Daemon ends natively answers within a moment. */
export const AGENT_TURN_INTERRUPT_FIRST_POLL_INTERVAL_MS = 250;
/** How often the panel asks for the Computer's outcome once it is taking a while. */
export const AGENT_TURN_INTERRUPT_POLL_INTERVAL_MS = 1_000;
/** Twice the Daemon's worst case (a 10 second native budget, then a runtime restart with a 5
 * second release) and inside the 60 second lifetime of a stored result. */
export const AGENT_TURN_INTERRUPT_CLIENT_DEADLINE_MS = 30_000;

/**
 * Starts an interrupt and asks for its outcome until it settles (`pollForAnswer`). Whatever fails
 * on the way, and no outcome by the deadline, end as `failed`: the panel offers Retry. The wait is
 * never cancelled: the Daemon ends the stalled display before it reports, which unmounts the
 * panel, and its outcome is still owed to the person who asked.
 */
export async function interruptAgentTurnOutcome(options: {
  start(): Promise<AgentTurnInterruptStart>;
  read(requestId: string): Promise<AgentTurnInterruptRead>;
  intervalMs?: number;
  deadlineMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<AgentTurnInterruptOutcome> {
  try {
    const started = await options.start();
    if (started.status === "refused") return started.reason;
    const answer = await pollForAnswer<AgentTurnInterruptRead | { status: "failed" }>({
      read: () => options.read(started.requestId),
      onGiveUp: { status: "failed" },
      signal: new AbortController().signal,
      firstIntervalMs: AGENT_TURN_INTERRUPT_FIRST_POLL_INTERVAL_MS,
      intervalMs: options.intervalMs ?? AGENT_TURN_INTERRUPT_POLL_INTERVAL_MS,
      deadlineMs: options.deadlineMs ?? AGENT_TURN_INTERRUPT_CLIENT_DEADLINE_MS,
      now: options.now,
      sleep: options.sleep,
    });
    return answer.status === "settled" ? answer.outcome : "failed";
  } catch {
    return "failed";
  }
}
