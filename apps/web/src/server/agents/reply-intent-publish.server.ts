import {
  encodeAgentReplyIntent,
  REPLY_INTENT_PHASE,
  type AgentReplyIntent,
} from "@lrm/coforge-sdk/internal/reply-intent";

import { userConversationChannel } from "#src/features/conversations/conversation-realtime";
import {
  agentInPublicationScope,
  publicationDenied,
  publicationRerouted,
  relayActivityFrame,
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
 * One daemon "about to post" frame (`AgentActivity.reply_intent`), validated against the trusted
 * connection scope exactly like Activity. Where it goes depends on its target, which an end
 * repeats from its start:
 *
 * - a channel's frame is relayed on the channel the Agent's Activity uses: the shared one for a
 *   public Agent, its own for any other;
 * - a direct message's frame never touches an Activity channel, which would show the
 *   conversation's existence and timing to the Workspace: it is published to the one person's
 *   own channel (`chat:user:<id>`), and the daemon's publication is dropped.
 *
 * A start leaves with the conversation and thread its target resolves to; an end leaves as the
 * phase and call id alone. Nothing the daemon sent is relayed as it came, nothing is stored and
 * the Agent's display does not change. A frame the server cannot resolve is denied, which
 * Centrifugo answers by dropping that one publication.
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
  const { target } = intent;
  if (visibility === undefined || !target) return publicationDenied();

  const direct = !target.startsWith("#");
  const isStart = intent.phase === REPLY_INTENT_PHASE.START;
  // A channel's end goes where the Agent's Activity goes and needs nothing resolved.
  const resolved =
    isStart || direct
      ? await dependencies.resolveReplyTarget?.({
          workspaceId,
          agentId,
          callId: intent.callId,
          target,
        })
      : undefined;
  if ((isStart || direct) && !resolved) return publicationDenied();

  const data = encodeAgentReplyIntent({
    ...frame,
    intent:
      isStart && resolved
        ? {
            phase: intent.phase,
            callId: intent.callId,
            ...(intent.early ? { early: true } : {}),
            conversationId: resolved.conversationId,
            ...(resolved.threadRootId ? { threadRootId: resolved.threadRootId } : {}),
          }
        : { phase: intent.phase, callId: intent.callId },
  });
  if (!direct) return relayActivityFrame(data, { workspaceId, agentId, visibility }, dependencies);
  if (!resolved?.peerUserId) return publicationDenied();
  await dependencies
    .publish?.(userConversationChannel(resolved.peerUserId), data, { skipHistory: true })
    .catch(() => {});
  return publicationRerouted("the person's own channel");
}
