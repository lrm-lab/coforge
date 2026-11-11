import {
  AUTOMATIC_START_STREAK_LIMIT,
  isEligibleForTransientRetry,
  type AgentControlAgent,
} from "./agent-control-types.server";

/**
 * Whether an automatic Start — a Daemon `ready` recovery or a message's wake — may begin for an
 * Agent whose latest operation failed. Its own module because the decision has grown past one
 * condition: a non-retryable failure, a failure outside the bounded window and an Agent that used
 * up its consecutive automatic attempts are all refusals, and the last one also owes the log line
 * that says the Agent now waits for a person.
 */
export function retryFailedAutomaticStart(agent: AgentControlAgent, now: number): boolean {
  if (isEligibleForTransientRetry(agent, now)) return true;
  const state = agent.state;
  // An Agent that used up its automatic attempts stays failed until a person starts it: say so
  // once per refused wake, so a fleet-wide start failure is one line, not silence.
  if ((state?.failedStreak ?? 0) >= AUTOMATIC_START_STREAK_LIMIT)
    console.warn(
      JSON.stringify({
        event: "agent_control:auto_start_gave_up",
        agent_id: agent.id,
        workspace_id: agent.workspaceId,
        computer_id: agent.computerId,
        request_id: state?.requestId,
        error_code: state?.errorCode,
        failed_streak: state?.failedStreak,
        outcome: "needs_manual_start",
      }),
    );
  return false;
}
