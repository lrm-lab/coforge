import {
  encodeAgentReplyIntent,
  REPLY_INTENT_PHASE,
  type AgentReplyIntent,
} from "@lrm/coforge-sdk/internal/reply-intent";

import {
  conversationRealtimeChannel,
  userConversationChannel,
} from "#src/features/conversations/conversation-realtime";
import {
  agentInPublicationScope,
  publicationDenied,
  publicationRerouted,
  type ActivityRelayDependencies,
} from "./agent-activity-relay.server";

/** Where an Agent's send would post. `peerUserId` is set for a direct message: the person on its
 * other side, who is the only one the signal may reach. */
export type ReplyIntentTarget = {
  conversationId: string;
  threadRootId: string | null;
  peerUserId?: string;
};

/** Where the Agent's send `target` (read for `callId`) would post; nothing for a target it
 * cannot post to. */
export type ReplyTargetResolver = (call: {
  workspaceId: string;
  agentId: string;
  callId: string;
  target: string;
}) => Promise<ReplyIntentTarget | undefined>;

export type ReplyIntentPublicationDependencies = ActivityRelayDependencies & {
  /** Without it no reply intent is relayed. */
  resolveReplyTarget?: ReplyTargetResolver;
};

/**
 * A transient send intent, checked against the trusted daemon scope, then published once to its
 * resolved conversation (or a DM viewer's own channel). Both phases resolve the same target;
 * repeats reuse its cache. An end carries only call/phase to the browser, whose subscription
 * supplies the conversation scope. No intent reaches Activity, history, storage or display.
 */
export async function handleReplyIntentPublication(
  frame: AgentReplyIntent,
  scope: { workspaceId: string; computerId: string },
  dependencies: ReplyIntentPublicationDependencies,
): Promise<Response> {
  const { workspaceId, computerId } = scope;
  const { agentId, intent } = frame;
  if (
    frame.workspaceId !== workspaceId ||
    !(await agentInPublicationScope(dependencies, { workspaceId, computerId, agentId }))
  )
    return publicationDenied();
  const visibility = await dependencies.agentVisibility(workspaceId, agentId);
  if (visibility === undefined) return publicationDenied();
  const unresolvedTarget = () => {
    if (intent.phase === REPLY_INTENT_PHASE.END)
      console.debug(
        JSON.stringify({
          event: "reply_intent:end_unresolved",
          workspace_id: workspaceId,
          agent_id: agentId,
          call_id: intent.callId,
        }),
      );
    return publicationDenied();
  };
  const { target } = intent;
  if (!target) return unresolvedTarget();
  const direct = !target.startsWith("#");
  const isStart = intent.phase === REPLY_INTENT_PHASE.START;
  const resolved = await dependencies
    .resolveReplyTarget?.({
      workspaceId,
      agentId,
      callId: intent.callId,
      target,
    })
    .catch(() => undefined);
  if (!resolved) return unresolvedTarget();

  const data = encodeAgentReplyIntent({
    ...frame,
    intent: isStart
      ? {
          phase: intent.phase,
          callId: intent.callId,
          ...(intent.early ? { early: true } : {}),
          conversationId: resolved.conversationId,
          ...(resolved.threadRootId ? { threadRootId: resolved.threadRootId } : {}),
        }
      : { phase: intent.phase, callId: intent.callId },
  });
  const channel = direct
    ? resolved.peerUserId && userConversationChannel(resolved.peerUserId)
    : conversationRealtimeChannel(resolved.conversationId);
  if (!channel) return publicationDenied();
  await dependencies.publish?.(channel, data, { skipHistory: true }).catch(() => {});
  return publicationRerouted(direct ? "the person's own channel" : "the conversation's channel");
}
