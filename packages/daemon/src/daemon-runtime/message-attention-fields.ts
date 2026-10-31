import {
  isAttachmentMessageTarget,
  isChannelMessageTarget,
  threadParentTarget,
  type AgentMessageDelivery,
} from "@lrm/coforge-sdk/internal";
import type { MessageAttention } from "./agent-message-attention-index";

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
    (message.target.startsWith("@") ||
      isChannelMessageTarget(message.target) ||
      isAttachmentMessageTarget(message.target)) &&
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
    isChannelMessageTarget(target)
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
