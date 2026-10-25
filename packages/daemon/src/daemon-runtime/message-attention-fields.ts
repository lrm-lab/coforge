import { isChannelMessageTarget } from "@lrm/coforge-sdk/internal";
import type { MessageAttention } from "./agent-message-attention-index";

/** A target's flags once one more pending message joins it. */
export function attentionFlags(
  target: string,
  nonMemberMention: boolean | undefined,
  previous: MessageAttention | undefined,
): string[] {
  return [
    isChannelMessageTarget(target) ? "channel" : target.includes(":") ? "thread" : "dm",
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
