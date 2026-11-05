import { getLogger } from "@logtape/logtape";

const logger = getLogger(["coforge", "daemon", "runtime"]);

/**
 * The two turn boundaries, logged so a reader can measure from the log alone how long an accepted
 * notice waited before the turn it opened: `agent.inbox_notice.accepted` → `agent.turn.started` →
 * `agent.turn.finished`. A start with no finish is also a turn that never reported its end.
 */
export function noteTurnStarted(agentId: string, via: "delivery" | "prompt" | "startup"): void {
  logger.info("Agent turn started", {
    event: "agent.turn.started",
    agent_id: agentId,
    via,
  });
}

export function noteTurnFinished(
  agentId: string,
  status: "completed" | "interrupted" | "failed",
  conversationId?: string,
): void {
  logger.info("Agent turn finished", {
    event: "agent.turn.finished",
    agent_id: agentId,
    status,
    ...(conversationId ? { conversation_id: conversationId } : {}),
  });
}
