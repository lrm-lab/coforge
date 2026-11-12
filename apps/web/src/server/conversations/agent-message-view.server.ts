import { copiesOf, type ForwardCopy } from "./message-forward-view.server";
import {
  MESSAGE_LINE_SEPARATOR,
  renderForwardedMessage,
  type ForwardedMessage,
  type TaskReference,
} from "@lrm/coforge-sdk/internal";
import { CHOICE_OTHER_DEFAULT_LABEL, CHOICE_OTHER_OPTION_ID } from "@lrm/coforge-sdk/agent";
import {
  agentReadableBody,
  deliveryMentionsAgent,
  type MessageMentionRef,
} from "./mentions.server";
import type { QuestionsAnswer } from "./action-card-questions.server";
import { cardAnsweredHead, cardDeclinedBody, cardPerson } from "./action-card-outcome-body.server";

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
 * snapshots, oldest first (with the message's own attachments), when it is a forward. */
type StoredAgentMessage = {
  body: string;
  mentions: readonly MessageMentionRef[];
  actionCard?: {
    state: string;
    kind?: string | null;
    result?: unknown;
    committedByUser?: { username: string } | null;
  } | null;
  forwards?: readonly StoredAgentForward[];
  /** With which original of a forward of several each is a copy of. */
  attachments?: readonly ForwardCopy[];
};

/**
 * A person's own words, fenced: every continuation line carries the `│` prefix message text uses,
 * so an answer cannot look like CLI output or a second message (task #336).
 */
export function fenceUserText(text: string): string {
  return text.split(MESSAGE_LINE_SEPARATOR).join("\n  │ ");
}

/** A person's own answer on the lines under a card's state, fenced as its delivery fences it. */
function ownWords(text: unknown, question?: string): string {
  if (typeof text !== "string" || !text) return "";
  return `\n  │ ${fenceUserText(question ? `${question}: ${text}` : text)}`;
}

/** Appended so an Agent can tell pending from executed, which `choice` was picked, and what the
 * person wrote when they answered in their own words: a reader never sees the delivery's copy. */
export function actionCardBodySuffix(card: {
  state: string;
  kind?: string | null;
  result?: unknown;
  committedByUser?: { username: string } | null;
}): string {
  // Who settled the card, as its commit recorded it; a deleted user's row reads as no name.
  const by = card.committedByUser?.username ? ` by @${card.committedByUser.username}` : "";
  if (card.state === "executed" && card.kind === "choice") {
    const optionId =
      card.result &&
      typeof card.result === "object" &&
      "optionId" in card.result &&
      typeof (card.result as { optionId: unknown }).optionId === "string"
        ? (card.result as { optionId: string }).optionId
        : "";
    if (optionId === CHOICE_OTHER_OPTION_ID || /^[a-z][a-z0-9_]{0,31}$/.test(optionId)) {
      // The answer is the option the Agent recommended, as its delivery says too.
      const recommended = (card.result as { recommended?: unknown }).recommended === true;
      const state = `[action card: executed; choice=${optionId}${recommended ? " (recommended)" : ""}${by}]`;
      return optionId === CHOICE_OTHER_OPTION_ID
        ? state + ownWords((card.result as { text?: unknown }).text)
        : state;
    }
  }
  if (card.state === "executed" && card.kind === "questions") {
    const answers =
      card.result && typeof card.result === "object" && "answers" in card.result
        ? (card.result as { answers?: unknown }).answers
        : undefined;
    if (Array.isArray(answers)) {
      let words = "";
      const parts = answers.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const { questionId, selection, skipped } = entry as {
          questionId?: unknown;
          selection?: unknown;
          skipped?: unknown;
        };
        if (typeof questionId !== "string" || !Array.isArray(selection)) return [];
        // A question left unanswered is said so, as the wake-up does, not dropped from the line.
        if (skipped === true) return [`${questionId}=(skipped)`];
        for (const option of selection as { optionId?: unknown; text?: unknown }[]) {
          if (option?.optionId === CHOICE_OTHER_OPTION_ID) {
            words += ownWords(option.text, questionId);
          }
        }
        const picked = selection
          .map((option) =>
            option && typeof option === "object" && "optionId" in option
              ? String((option as { optionId: unknown }).optionId)
              : "",
          )
          .filter(Boolean)
          .join(",");
        return picked ? [`${questionId}=${picked}`] : [];
      });
      if (parts.length) return `[action card: executed; ${parts.join("; ")}${by}]${words}`;
    }
  }
  return `[action card: ${card.state}${by}]`;
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
  const chosen =
    result?.optionId === CHOICE_OTHER_OPTION_ID
      ? `${result.label ?? CHOICE_OTHER_DEFAULT_LABEL} (their own words)\n  │ ${fenceUserText(result.text ?? "")}`
      : result?.label
        ? `${result.optionId ?? ""} · ${result.label}`.trim()
        : "an option";
  const head = cardAnsweredHead(cardPerson(chooser?.handle), {
    kind: "choice",
    prompt: payload?.prompt,
    target,
  });
  return `${head}: ${chosen}` as AgentReadableBody;
}

/** The questions card's answers as the asking Agent reads them, woken or replaying it later: who
 * answered, where, and each question's prompt over its picks, a skipped one as `(skipped)`. */
export function questionsResultBody(
  answers: readonly QuestionsAnswer[],
  who: string,
  target: string,
  prompt?: string,
): AgentReadableBody {
  const lines = answers.map((answer) => {
    if (answer.skipped) return `${answer.prompt} → (skipped)`;
    const picked = answer.selection
      .map((option) =>
        option.optionId === CHOICE_OTHER_OPTION_ID
          ? `${option.label} (their own words)`
          : `${option.optionId} · ${option.label}${option.recommended ? " (recommended)" : ""}`,
      )
      .join(", ");
    const otherText = answer.selection.find(
      (option) => option.optionId === CHOICE_OTHER_OPTION_ID,
    )?.text;
    return (
      `${answer.prompt} → ${picked}` +
      (otherText !== undefined ? `\n  │ ${fenceUserText(otherText)}` : "")
    );
  });
  const head = cardAnsweredHead(who, { kind: "questions", prompt, target });
  return `${head}:\n${lines.join("\n")}` as AgentReadableBody;
}

/** The notice an Agent missed when the person a `choice` or `questions` card asked declined it. */
export function cardDeclinedNotice(
  card: { kind: string; payload: unknown },
  target: string,
  decliner?: { handle: string } | null,
): AgentReadableBody {
  const payload = card.payload as { prompt?: string } | null;
  return cardDeclinedBody(cardPerson(decliner?.handle), {
    kind: card.kind,
    prompt: payload?.prompt,
    target,
  }) as AgentReadableBody;
}

/** A forward's originals as an Agent reads them, oldest first, each with its own attachments. */
export function agentForwards(
  forwards: readonly StoredAgentForward[],
  attachments: readonly ForwardCopy[] = [],
): ForwardedMessage[] {
  // One original owns every attachment of its message; with several, each copy names its own.
  if (forwards.length === 1) return [agentForwarded(forwards[0]!, attachments)];
  return forwards.map((forward, position) =>
    agentForwarded(
      forward,
      copiesOf(attachments, position).map((id) => ({ id })),
    ),
  );
}

/** One original as an Agent reads it. The snapshot body is already plain text. */
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
 * - A forward's `body` stays the forwarder's note; its originals, oldest first, are
 *   `forwardedMessages` (one item for a single message). `forwarded` repeats the first, only for
 *   Computers whose CLI predates the list.
 */
export function agentMessageView(
  message: StoredAgentMessage,
  readerAgentId?: string,
  channelCoordination?: string,
): {
  body: AgentReadableBody;
  channelCoordination?: string;
  mentionsAgent?: true;
  forwardedMessages?: ForwardedMessage[];
  /** @deprecated Wire compatibility only, derived from `forwardedMessages[0]`: a CLI before the
   * list reads this field. Remove once every online Computer runs a CLI that reads
   * `forwardedMessages` (task #2 in Frank's DM, 11-06). Nothing in this repository reads it. */
  forwarded?: ForwardedMessage;
} {
  const { text, mentionsAgent, forwarded } = projectMessage(message, readerAgentId);
  return {
    body: text as AgentReadableBody,
    ...(channelCoordination ? { channelCoordination } : {}),
    ...(mentionsAgent ? { mentionsAgent } : {}),
    ...(forwarded[0] ? { forwardedMessages: forwarded, forwarded: forwarded[0] } : {}),
  };
}

/**
 * `agentMessageView` for what an Agent's daemon is handed as one body, whose delivery carries a
 * body and nothing else (recoveries and pending deliveries): a forward's originals are read into
 * the body after the note (`withForwarded`), so the Agent sees them where the notice shows the
 * message. The structured `forwarded` is left out, as there is no field for it.
 */
export function agentDeliveryView(
  message: StoredAgentMessage,
  readerAgentId?: string,
  /** How this reader sees a task reference (see `taskReferenceView`). */
  taskView?: (reference: TaskReference) => string | undefined,
): { body: AgentReadableBody; mentionsAgent?: true } {
  const { text, mentionsAgent, forwarded } = projectMessage(message, readerAgentId, taskView);
  return {
    body: (forwarded.length ? withForwarded(text, forwarded) : text) as AgentReadableBody,
    ...(mentionsAgent ? { mentionsAgent } : {}),
  };
}

function projectMessage(
  message: StoredAgentMessage,
  readerAgentId?: string,
  taskView?: (reference: TaskReference) => string | undefined,
): { text: string; mentionsAgent?: true; forwarded: ForwardedMessage[] } {
  const readable = agentReadableBody(message.body, message.mentions, taskView);
  return {
    text: message.actionCard ? `${readable} ${actionCardBodySuffix(message.actionCard)}` : readable,
    ...(readerAgentId && deliveryMentionsAgent(message.mentions, readerAgentId)
      ? { mentionsAgent: true as const }
      : {}),
    forwarded: agentForwards(message.forwards ?? [], message.attachments),
  };
}

/** A delivery body with a forward's originals after the note, oldest first; the note may be
 * empty. */
export function withForwarded(note: string, forwarded: readonly ForwardedMessage[]): string {
  const originals = forwarded
    .map((original) => renderForwardedMessage(original, { withAttachmentIds: true }))
    .join("\n");
  return note ? `${note}\n${originals}` : originals;
}
