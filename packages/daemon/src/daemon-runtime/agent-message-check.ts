import { getLogger } from "@logtape/logtape";
import type {
  AgentMessageRecord,
  AgentMessageResponse,
  LocalAgentMessageRequest,
} from "@lrm/coforge-sdk/internal";
import type { AgentMessageOperationsPorts } from "./agent-message-ports";
import { elideForAgent } from "./context-elision";

const logger = getLogger(["coforge", "daemon", "agent-message"]);

/** Bounds how many events pages one `check` drains before reporting `hasMore: true` and yielding. */
const MAX_EVENT_DRAIN_ROUNDS = 50;

/** The log's correlation field is `request_id`; on the Agent HTTP path it carries the request's
 * idempotency key. */
export function agentLogScope(
  ports: AgentMessageOperationsPorts,
  agentId: string,
  idempotencyKey: string,
) {
  return {
    request_id: idempotencyKey,
    workspace_id: ports.connection.workspaceId,
    computer_id: ports.connection.computerId,
    agent_id: agentId,
  };
}

/**
 * Drains the server-side events page for the Agent until it reports no more remain. The server
 * owns pagination and advances the canonical read boundary as it returns each page
 * (ack-on-drain); this loop only reconciles the daemon's volatile notice index afterward.
 */
export async function checkPendingMessages(
  ports: AgentMessageOperationsPorts,
  agentId: string,
  request: LocalAgentMessageRequest,
  agentApiKey: string,
  target = request.target,
): Promise<AgentMessageResponse> {
  const startedAt = performance.now();
  const attention = ports.attention
    .check(agentId)
    .filter((item) => !target || item.target === target);
  const messages: AgentMessageRecord[] = [];
  let hasMore = false;
  let roundCount = 0;
  while (roundCount < MAX_EVENT_DRAIN_ROUNDS) {
    roundCount += 1;
    const result = await ports.transport.agentMessage!(
      {
        idempotencyKey: request.idempotencyKey,
        agentId,
        workspaceId: ports.connection.workspaceId,
        operation: "check",
        target: target || "",
        limit: request.limit,
      },
      agentApiKey,
    );
    if (!result.accepted || result.messages.length === 0) {
      hasMore = false;
      break;
    }
    messages.push(...result.messages);
    hasMore = Boolean(result.hasMore);
    if (!hasMore) break;
  }
  // A `check` records the exact sequences it showed, per target, and no frontier: a check
  // drains what notified the Agent, which need not be every message of the target. It reviews
  // nothing either, so it takes no read order.
  const shownByTarget = new Map<string, number[]>();
  for (const message of messages) {
    const shown = shownByTarget.get(message.target);
    if (shown) shown.push(message.sequence);
    else shownByTarget.set(message.target, [message.sequence]);
  }
  ports.attention.recordExactSeen(agentId, shownByTarget);
  logger.info("Agent checked pending messages", {
    event: "agent.message.checked",
    ...agentLogScope(ports, agentId, request.idempotencyKey),
    pending_count: attention.reduce((count, item) => count + item.pendingCount, 0),
    displayed_count: messages.length,
    round_count: roundCount,
    has_more: hasMore,
    duration_ms: Math.round(performance.now() - startedAt),
    outcome: "ok",
  });
  // The App Inbox is read only to say so when a check found no message. Before the messages are
  // elided: a read that throws after that would leave their claims with nothing to give them back.
  const appItemsPending =
    messages.length === 0 ? await ports.appItemsPending?.(agentId) : undefined;
  return {
    idempotencyKey: request.idempotencyKey,
    accepted: true,
    attentionCount: attention.reduce((n, a) => n + a.pendingCount, 0),
    summaries: attention.map((item) => ({ ...item, flags: [...item.flags] })),
    messages: elideForAgent(ports.contexts, agentId, messages, "check"),
    messageId: "",
    hasMore,
    appItemsPending,
  };
}
