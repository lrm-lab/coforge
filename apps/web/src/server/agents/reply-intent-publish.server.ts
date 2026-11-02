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
  const { target } = intent;
  const isStart = intent.phase === REPLY_INTENT_PHASE.START;
  /**
   * The intent is dropped: nothing shows "X is replying". An end only clears what a start showed,
   * so it is debugged; a start dropped is why a reply showed no signal (task #117), so it is
   * logged with what the target says without its name: direct or channel, and a thread's anchor.
   */
  const unresolvedTarget = (
    reason: "no_target" | "unresolved" | "resolver_failed",
    error?: unknown,
  ) => {
    const record = {
      workspace_id: workspaceId,
      agent_id: agentId,
      call_id: intent.callId,
      reason,
      ...(error === undefined ? {} : { error_type: errorType(error) }),
    };
    if (isStart)
      console.warn(
        JSON.stringify({
          event: "reply_intent:start_unresolved",
          ...record,
          ...targetShape(target),
        }),
      );
    else console.debug(JSON.stringify({ event: "reply_intent:end_unresolved", ...record }));
    return publicationDenied();
  };
  if (!target) return unresolvedTarget("no_target");
  const direct = !target.startsWith("#");
  let found: ReplyIntentTarget | undefined;
  try {
    found = await dependencies.resolveReplyTarget?.({
      workspaceId,
      agentId,
      callId: intent.callId,
      target,
    });
  } catch (error) {
    return unresolvedTarget("resolver_failed", error);
  }
  if (!found) return unresolvedTarget("unresolved");
  const resolved = found;

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
  await dependencies.publish?.(channel, data, { skipHistory: true }).catch((error: unknown) => {
    console.warn(
      JSON.stringify({
        event: "reply_intent:publish_failed",
        workspace_id: workspaceId,
        agent_id: agentId,
        call_id: intent.callId,
        phase: intent.phase,
        conversation_id: resolved.conversationId,
        thread_root_id: resolved.threadRootId,
        error_type: errorType(error),
      }),
    );
  });
  return publicationRerouted(direct ? "the person's own channel" : "the conversation's channel");
}

/** What a send target addresses, without the channel's or person's name: a thread's anchor is a
 * message id. */
function targetShape(target: string | undefined) {
  if (!target) return { target_kind: "none" };
  if (!target.startsWith("#")) return { target_kind: "direct" };
  const anchor = target.slice(1).split(":")[1];
  return anchor ? { target_kind: "thread", thread_anchor: anchor } : { target_kind: "channel" };
}

const errorType = (error: unknown) => (error instanceof Error ? error.name : typeof error);
