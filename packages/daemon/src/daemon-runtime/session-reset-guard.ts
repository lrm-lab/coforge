import { getLogger } from "@logtape/logtape";
import { createCodeAgentProvider } from "#src/code-agent/registry";

const logger = getLogger(["coforge", "daemon", "runtime"]);

/** A session whose compactions keep failing, on a runtime where that sticks to the session, will
 * not recover by resuming it: the person resets it from the Agent page instead. */
export class RuntimeSessionNeedsResetError extends Error {
  constructor(agentId: string) {
    super(
      `This session's context compaction failed repeatedly (agent ${agentId}). Reset the session from the Agent page (Reset Session & Restart).`,
    );
    this.name = "RuntimeSessionNeedsResetError";
  }
}

/** Whether a runtime's compaction failures stick to the session, per Raft's per-driver
 * declaration: `PiDriver.session.compactionFailure = "sticks_to_session"`, the other drivers
 * `"does_not_stick"`. An unknown provider — and a provider that declares nothing — does not stick. */
export function compactionFailuresStickToSession(provider: string): boolean {
  try {
    return createCodeAgentProvider(provider as never).compactionFailure === "sticks_to_session";
  } catch {
    return false;
  }
}

/** Refuses the launch that would resume a spent session; a no-op for a healthy one, or a runtime
 * whose compaction failures do not stick. */
export function assertSessionNotSpent(input: {
  agentId: string;
  provider: string;
  needsReset: boolean;
}): void {
  if (!input.needsReset || !compactionFailuresStickToSession(input.provider)) return;
  logger.warn("Agent start refused: the session needs a reset", {
    event: "daemon.agent.start.session_needs_reset",
    agent_id: input.agentId,
    provider: input.provider,
  });
  throw new RuntimeSessionNeedsResetError(input.agentId);
}
