import { renderForwardedMessage, type ForwardedMessage } from "@lrm/coforge-sdk/internal";
import {
  agentReadableBody,
  deliveryMentionsAgent,
  type MessageMentionRef,
} from "./mentions.server";

declare const readable: unique symbol;

/**
 * A message body as an Agent reads it: every stored token read back as text. Only
 * `agentMessageView` makes one (its single cast), and `test/agent-delivery-choke-point.test.ts`
 * requires this type on the `body` of every Agent-facing read of the conversation repository.
 *
 * So a repository serializer fails to type-check when it ships a stored body (`body: row.body`),
 * overrides the projected body after spreading the view, or edits the projected body (any string
 * operation returns a plain `string`).
 *
 * What it cannot catch: another `as AgentReadableBody` cast (the choke-point scan allows it only
 * here), an Agent-facing reader outside `PrismaDirectConversationRepository` that the check does
 * not list, and port-typed values such as test fakes, whose `body` is a plain `string`.
 */
export type AgentReadableBody = string & { readonly [readable]: true };

/** The snapshot columns of a forward (`MessageForward`) an Agent reads. */
export type StoredAgentForward = {
  sourceConversationName: string | null;
  sourceThreadRootId: string | null;
  sourceSenderHandle: string;
  sourceCreatedAt: Date;
  sourceBody: string;
};

/** A stored message as the Agent projection needs it: its body and the mention rows that resolve
 * the body's mention tokens, plus an action card's state when the reader shows one, and the
 * snapshot (with the message's own attachments) when it is a forward. */
type StoredAgentMessage = {
  body: string;
  mentions: readonly MessageMentionRef[];
  actionCard?: { state: string } | null;
  forward?: StoredAgentForward | null;
  attachments?: readonly { id: string }[];
};

/** A forward's snapshot as an Agent reads it. The snapshot body is already plain text. */
export function agentForwarded(
  forward: StoredAgentForward,
  attachments: readonly { id: string }[] = [],
): ForwardedMessage {
  return {
    from: forward.sourceConversationName === null ? "DM" : `#${forward.sourceConversationName}`,
    ...(forward.sourceThreadRootId ? { thread: true as const } : {}),
    sender: `@${forward.sourceSenderHandle}`,
    sentAt: forward.sourceCreatedAt.toISOString(),
    body: forward.sourceBody,
    attachments: attachments.map((attachment) => attachment.id),
  };
}

/**
 * The one projection of a stored message onto every Agent-facing record: the Agent HTTP reads
 * (read, search, resolve, events, pending and recent context) and the daemon's recovery and
 * pending deliveries. Daemon pushes go through `encodeAgentDelivery` instead. Spread it into the
 * record.
 *
 * - `body` reads every stored token (`<@agent:…>`, `<@task:N>`, `<@channel:…>`, `<@thread:…>`)
 *   back as text, so none reaches an Agent.
 * - An action card's current state is appended to the body, so an Agent never treats a card that
 *   has not been acted on as a committed resource.
 * - With a `readerAgentId`, `mentionsAgent: true` is present when the message personally mentions
 *   that Agent.
 * - A forward's `body` stays the forwarder's note; the original is `forwarded`.
 */
export function agentMessageView(
  message: StoredAgentMessage,
  readerAgentId?: string,
  channelCoordination?: string,
): { body: AgentReadableBody; mentionsAgent?: true; forwarded?: ForwardedMessage } {
  const { text, mentionsAgent, forwarded } = projectMessage(
    message,
    readerAgentId,
    channelCoordination,
  );
  return {
    body: text as AgentReadableBody,
    ...(mentionsAgent ? { mentionsAgent } : {}),
    ...(forwarded ? { forwarded } : {}),
  };
}

/**
 * `agentMessageView` for what an Agent's daemon is handed as one body, whose delivery carries a
 * body and nothing else (recoveries and pending deliveries): a forward's original is read into
 * the body after the note (`withForwarded`), so the Agent sees it where the notice shows the
 * message. The structured `forwarded` is left out, as there is no field for it.
 */
export function agentDeliveryView(
  message: StoredAgentMessage,
  readerAgentId?: string,
  channelCoordination?: string,
): { body: AgentReadableBody; mentionsAgent?: true } {
  const { text, mentionsAgent, forwarded } = projectMessage(
    message,
    readerAgentId,
    channelCoordination,
  );
  return {
    body: (forwarded ? withForwarded(text, forwarded) : text) as AgentReadableBody,
    ...(mentionsAgent ? { mentionsAgent } : {}),
  };
}

function projectMessage(
  message: StoredAgentMessage,
  readerAgentId?: string,
  channelCoordination?: string,
): { text: string; mentionsAgent?: true; forwarded?: ForwardedMessage } {
  const readable = agentReadableBody(message.body, message.mentions);
  const content = channelCoordination ? `${channelCoordination}\n${readable}` : readable;
  return {
    text: message.actionCard ? `${content} [action card: ${message.actionCard.state}]` : content,
    ...(readerAgentId && deliveryMentionsAgent(message.mentions, readerAgentId)
      ? { mentionsAgent: true as const }
      : {}),
    ...(message.forward ? { forwarded: agentForwarded(message.forward, message.attachments) } : {}),
  };
}

/** A delivery body with a forward's original after the note; the note may be empty. */
export function withForwarded(note: string, forwarded: ForwardedMessage): string {
  const original = renderForwardedMessage(forwarded, { withAttachmentIds: true });
  return note ? `${note}\n${original}` : original;
}
