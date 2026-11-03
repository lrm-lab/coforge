import {
  MESSAGE_LINE_SEPARATOR,
  renderForwardedMessage,
  type ForwardedMessage,
} from "@lrm/coforge-sdk/internal";
import { CHOICE_OTHER_DEFAULT_LABEL, CHOICE_OTHER_OPTION_ID } from "@lrm/coforge-sdk/agent";
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
  actionCard?: { state: string; kind?: string; result?: unknown } | null;
  forward?: StoredAgentForward | null;
  attachments?: readonly { id: string }[];
};

/**
 * A person's own words, fenced: every continuation line carries the `│` prefix message text uses,
 * so an answer cannot look like CLI output or a second message (task #336).
 */
export function fenceUserText(text: string): string {
  return text.split(MESSAGE_LINE_SEPARATOR).join("\n  │ ");
}

/** Appended so an Agent can tell pending from executed, and which `choice` was picked. */
export function actionCardBodySuffix(card: {
  state: string;
  kind?: string;
  result?: unknown;
}): string {
  if (card.state === "executed" && card.kind === "choice") {
    const optionId =
      card.result &&
      typeof card.result === "object" &&
      "optionId" in card.result &&
      typeof (card.result as { optionId: unknown }).optionId === "string"
        ? (card.result as { optionId: string }).optionId
        : "";
    if (optionId === CHOICE_OTHER_OPTION_ID || /^[a-z][a-z0-9_]{0,31}$/.test(optionId)) {
      return `[action card: executed; choice=${optionId}]`;
    }
  }
  return `[action card: ${card.state}]`;
}

/** The choice result an offline Agent missed: who answered, which card, where, and what they chose. */
export function choiceResultBody(
  card: { kind: string; payload: unknown; result: unknown } | null,
  target: string,
  chooser?: { handle: string } | null,
): AgentReadableBody {
  const result = card?.result as
    | { optionId?: string; label?: string; text?: string }
    | null
    | undefined;
  const payload = card?.payload as { prompt?: string } | null | undefined;
  const prompt = payload?.prompt ? `"${payload.prompt}" ` : "";
  const chosen =
    result?.optionId === CHOICE_OTHER_OPTION_ID
      ? `${result.label ?? CHOICE_OTHER_DEFAULT_LABEL} (their own words)\n  │ ${fenceUserText(result.text ?? "")}`
      : result?.label
        ? `${result.optionId ?? ""} · ${result.label}`.trim()
        : "an option";
  const who = chooser?.handle ? `@${chooser.handle}` : "Someone";
  return `${who} answered your choice ${prompt}in ${target}: ${chosen}` as AgentReadableBody;
}

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
): {
  body: AgentReadableBody;
  channelCoordination?: string;
  mentionsAgent?: true;
  forwarded?: ForwardedMessage;
} {
  const { text, mentionsAgent, forwarded } = projectMessage(message, readerAgentId);
  return {
    body: text as AgentReadableBody,
    ...(channelCoordination ? { channelCoordination } : {}),
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
  /** The delivery's conversation and sender, for reading a DM task from the reader's seat. */
  seat?: { conversationId: string; senderHandle: string },
): { body: AgentReadableBody; mentionsAgent?: true } {
  const { text, mentionsAgent, forwarded } = projectMessage(message, readerAgentId, seat);
  return {
    body: (forwarded ? withForwarded(text, forwarded) : text) as AgentReadableBody,
    ...(mentionsAgent ? { mentionsAgent } : {}),
  };
}

function projectMessage(
  message: StoredAgentMessage,
  readerAgentId?: string,
  seat?: { conversationId: string; senderHandle: string },
): { text: string; mentionsAgent?: true; forwarded?: ForwardedMessage } {
  const readable = agentReadableBody(
    message.body,
    message.mentions,
    seat &&
      ((reference) =>
        reference.kind === "dm" && reference.conversationId === seat.conversationId
          ? `dm:@${seat.senderHandle}:#${reference.number}`
          : undefined),
  );
  return {
    text: message.actionCard ? `${readable} ${actionCardBodySuffix(message.actionCard)}` : readable,
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
