import {
  isChannelMessageTarget,
  isValidMessageSender,
  type AgentMessageDelivery,
  type MessageSenderKind,
} from "@lrm/coforge-sdk/internal";
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["coforge", "daemon", "message-attention"]);

/**
 * Validates a `(kind, handle)` pair before it can reach a model-visible notice:
 * the kind must be one of the closed values and the handle must match the public
 * handle grammar (or be empty for `system`). This replaces the former regex guard on a single
 * composed string — a newline can no longer reach a notice through a sender name, because the
 * handle is matched against the handle grammar and the kind against the closed set separately.
 * A rejected pair is logged by name and dropped rather than printed; it never fails the delivery
 * it came with.
 */
export function printableSender(
  kind: MessageSenderKind | undefined,
  handle: string | undefined,
): { kind: MessageSenderKind; handle: string } | undefined {
  if (kind === undefined) return undefined;
  if (!isValidMessageSender(kind, handle ?? "")) {
    logger.warn("rejected an unprintable message sender", {
      event: "message.sender_rejected",
      sender_kind: kind,
    });
    return undefined;
  }
  return { kind, handle: handle ?? "" };
}

/** Distinct messages in a delivery list. The same message can appear more than once: a request
 * retried while held is enqueued again so both attempts stay ACK-able, and a redelivery arriving
 * after the dedupe window is a second delivery of one message. A notice counts messages. */
export function countDistinctMessages(deliveries: readonly AgentMessageDelivery[]): number {
  return new Set(deliveries.map((delivery) => delivery.messageId)).size;
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
    (message.target.startsWith("@") || isChannelMessageTarget(message.target)) &&
    message.target.length >= 2 &&
    message.sequence >= 1,
  );
}
