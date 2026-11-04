import type { AgentMessageTransportResponse } from "#src/connection/agent-http-clients";
import type { LocalAgentMessageRequest } from "@lrm/coforge-sdk/internal";
import type { AgentMessageAttentionIndex } from "./agent-message-attention-index";
import { foldShownMessages } from "./unread-fold";

/** What one history read looked like to the daemon: the request, the server's page, and the
 * attention that was pending for the target before the read. */
type HistoryRead = Readonly<{
  request: LocalAgentMessageRequest;
  result: AgentMessageTransportResponse;
  /** No `--before`, `--after` or `--around`: with `unread` the read looked at what is unread now,
   * and without it at the newest page. */
  unpaged: boolean;
  attentionUpperBound: number | undefined;
}>;

/** The target the read consumed: the one the server resolved it to when it names this Agent's
 * consumption scope, and the one that was asked for otherwise. */
function consumedTarget(
  agentId: string,
  requestedTarget: string,
  result: AgentMessageTransportResponse,
) {
  const scope = result.consumptionScope?.agentId === agentId ? result.consumptionScope : undefined;
  return { scope, target: scope?.target ?? requestedTarget };
}

/**
 * What a history read showed the Agent (the `message read` bookkeeping), kept under the target
 * the server resolved the read to (its consumption scope; a channel's top level has none and is
 * already canonical). An anchored `--around` read, and a page the server does not call
 * contiguous (`modelSeenUpToSeq` null, such as a `--before` page), record the exact sequences
 * they showed and nothing else; so does the newest page of a read without an anchor, which
 * reviews the target as well but leaves the frontier where it was. A read with a boundary moves the frontier there, records what
 * it showed above it as exact, and reviews the target; so does a read that returned nothing. A
 * consumption scope for this Agent settles what the read returned in every spelling of its
 * conversation.
 */
function recordHistoryRead(
  attention: AgentMessageAttentionIndex,
  agentId: string,
  requestedTarget: string,
  { request, result, unpaged, attentionUpperBound }: HistoryRead,
): void {
  const { scope, target } = consumedTarget(agentId, requestedTarget, result);
  const shown: number[] = [];
  let visibleSequence = 0;
  for (const message of result.messages)
    if (message.target === target) {
      shown.push(message.sequence);
      if (message.sequence > visibleSequence) visibleSequence = message.sequence;
    }
  const through = request.around ? 0 : (result.modelSeenUpToSeq ?? 0);
  attention.noticeActionClocks.noteAgentAction(agentId);
  attention.recordHistoryRead(agentId, {
    spelling: requestedTarget,
    target,
    shown,
    through,
    // The thread-mismatch guard's read context: a read that joined what the Agent had read, or
    // found nothing, reviews `target` and remembers the newest message it showed.
    review:
      !request.around &&
      (through > 0 || result.messages.length === 0 || (unpaged && !request.unread))
        ? { sequence: visibleSequence }
        : undefined,
    scope,
  });
  // An unread page holding nothing listable (only the Agent's own messages) while more remain has
  // not shown what the pending attention is about.
  if (
    unpaged &&
    request.unread &&
    result.messages.length === 0 &&
    !result.moreUnread &&
    attentionUpperBound !== undefined
  )
    attention.clearThrough(agentId, target, attentionUpperBound);
}

/**
 * Settles one accepted history read: an unread read first folds the messages the Agent was already
 * shown out of the page (recording the read would make every message on it look shown), then the
 * read is recorded. Returns the messages to hand the Agent and what was folded.
 */
export function settleHistoryRead(
  attention: AgentMessageAttentionIndex,
  agentId: string,
  requestedTarget: string,
  read: HistoryRead,
) {
  const page = read.request.unread
    ? foldShownMessages(
        attention,
        agentId,
        consumedTarget(agentId, requestedTarget, read.result).target,
        read.result.messages,
      )
    : { messages: read.result.messages, folded: undefined };
  recordHistoryRead(attention, agentId, requestedTarget, read);
  return page;
}

/** What a forwarded task-conversation read showed the Agent: `recordHistoryRead` over the
 * route's response body. Its consumption scope spells `#board:#N` — the discussion's own
 * canonical target — so replayed deliveries of it dedupe against the cursor the read writes. A
 * body without this Agent's scope is ignored. */
export function settleForwardedTaskRead(
  attention: AgentMessageAttentionIndex,
  agentId: string,
  query: Record<string, string> | undefined,
  result: unknown,
) {
  const page = result as AgentMessageTransportResponse;
  const scope = page?.consumptionScope;
  if (scope?.agentId !== agentId || !scope.target) return;
  // The scope carries the conversation id: bind now so the cursor survives a restart, not only
  // until the next delivery binds it.
  attention.bindConversation(agentId, scope.target, scope.conversationId);
  // The unread-empty clear's bound is the attention the read was issued against, as for a
  // `message read` (`attentionUpperBound`): a delivery that arrived since is not stale.
  const upperBound = attention
    .check(agentId)
    .find((item) => item.target === scope.target)?.latestSequence;
  const shown: number[] = [];
  for (const message of page.messages)
    if (message.target === scope.target) shown.push(message.sequence);
  // A task read joins no thread context — nothing records `review`, so the thread-mismatch send
  // guard does not learn a task ref as the channel's latest read.
  attention.noticeActionClocks.noteAgentAction(agentId);
  attention.recordHistoryRead(agentId, {
    spelling: scope.target,
    target: scope.target,
    shown,
    through: query?.around ? 0 : (page.modelSeenUpToSeq ?? 0),
    review: undefined,
    scope,
  });
  if (
    !query?.before &&
    !query?.after &&
    !query?.around &&
    query?.unread === "true" &&
    page.messages.length === 0 &&
    !page.moreUnread &&
    upperBound !== undefined
  )
    attention.clearThrough(agentId, scope.target, upperBound);
}

/** Distinct messages in a delivery list. The same message can appear more than once: a request
 * retried while held is enqueued again so both attempts stay ACK-able, and a redelivery arriving
 * after the dedupe window is a second delivery of one message. A notice counts messages. */
export function countDistinctMessages(
  deliveries: readonly { messageId: string }[],
): number {
  return new Set(deliveries.map((delivery) => delivery.messageId)).size;
}
