import {
  isAttachmentMessageTarget,
  isChannelMessageTarget,
  isTaskConversationTarget,
  threadParentTarget,
  type AgentMessageDelivery,
  type AgentRecoveryMessage,
} from "@lrm/coforge-sdk/internal";
import type { MessageAttention } from "./agent-message-attention-index";

/** A target attention will hold. `@…` covers a direct message and `@peer:#N`. A task on a channel
 * or written `dm:@peer:#N` matches neither the `@` prefix nor a channel thread anchor. */
export function isDeliveryTarget(target: string): boolean {
  return (
    target.startsWith("@") ||
    isChannelMessageTarget(target) ||
    isAttachmentMessageTarget(target) ||
    isTaskConversationTarget(target)
  );
}

/** The fields every delivery must carry before it can touch attention or be acknowledged. */
export function hasDeliveryScope(
  message: AgentMessageDelivery,
): message is AgentMessageDelivery & { target: string } {
  return Boolean(
    message.conversationId &&
    message.agentId &&
    message.messageId &&
    message.body &&
    message.target &&
    isDeliveryTarget(message.target) &&
    message.target.length >= 2 &&
    message.sequence >= 1,
  );
}

/** A target's flags once one more pending message joins it. */
export function attentionFlags(
  target: string,
  nonMemberMention: boolean | undefined,
  previous: MessageAttention | undefined,
): string[] {
  return [
    isTaskConversationTarget(target)
      ? "task"
      : isChannelMessageTarget(target)
        ? "channel"
        : isAttachmentMessageTarget(target)
          ? threadParentTarget(target) === undefined
            ? "attachment"
            : "thread"
          : target.includes(":")
            ? "thread"
            : "dm",
    // Reached the Agent from outside the channel: it can read the message, not reply there.
    ...(nonMemberMention || previous?.flags.includes("non_member_mention")
      ? ["non_member_mention"]
      : []),
  ];
}

/** The newest creation time among a target's pending messages; absent while none carried one (a
 * server that predates it). */
export function latestCreatedAtField(
  previous: MessageAttention | undefined,
  createdAtMs: number | undefined,
): Pick<MessageAttention, "latestCreatedAtMs"> {
  const latest = Math.max(previous?.latestCreatedAtMs ?? 0, createdAtMs ?? 0);
  return latest > 0 ? { latestCreatedAtMs: latest } : {};
}

/** Folds one adopted recovery message into its target's pending attention: the count, the
 * sequence bounds, the newest sender and the target flags all advance together. */
export function foldMessageAttention(
  byTarget: Map<string, MessageAttention>,
  message: AgentRecoveryMessage,
): void {
  const previous = byTarget.get(message.target);
  byTarget.set(message.target, {
    target: message.target,
    pendingCount: (previous?.pendingCount ?? 0) + 1,
    firstPendingSequence: Math.min(
      previous?.firstPendingSequence ?? message.sequence,
      message.sequence,
    ),
    latestSequence: Math.max(previous?.latestSequence ?? 0, message.sequence),
    ...latestCreatedAtField(previous, message.createdAtMs),
    latestSenderKind: message.latestSenderKind,
    latestSenderHandle: message.latestSenderHandle,
    flags: attentionFlags(message.target, message.nonMemberMention, previous),
  });
}
