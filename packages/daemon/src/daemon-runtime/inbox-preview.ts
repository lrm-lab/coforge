import {
  foldUntrustedLine,
  isValidMessageSender,
  truncateCodePoints,
  type AgentMessageDelivery,
} from "@lrm/coforge-sdk/internal";

/** What a preview reads from a delivery; a recovery message carries only the first two fields
 * and therefore never previews. */
export type PreviewSource = Partial<Pick<AgentMessageDelivery, "body">> &
  Partial<
    Pick<
      AgentMessageDelivery,
      | "target"
      | "latestSenderKind"
      | "latestSenderHandle"
      | "attachmentCount"
      | "source"
      | "mentionDelivery"
    >
  >;

/** How much of one message a notice shows: one line, this many characters at most. */
export const INBOX_PREVIEW_MAX_CHARS = 80;
/** How many previews one target's line may carry (task #424). */
export const INBOX_PREVIEW_LIMIT = 5;

const TRUNCATED = " (truncated)";

/** How many previews one target's line may carry: `COFORGE_INBOX_PREVIEW_LIMIT`, defaulting to
 * `INBOX_PREVIEW_LIMIT`; `0` turns previews off; anything else is ignored. */
export function inboxPreviewLimit(
  environment: Readonly<Record<string, string | undefined>> = Bun.env,
): number {
  const raw = environment.COFORGE_INBOX_PREVIEW_LIMIT;
  if (raw === undefined || raw.trim() === "") return INBOX_PREVIEW_LIMIT;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : INBOX_PREVIEW_LIMIT;
}

/** The message's own text, folded onto one line — the notice is a line-oriented block. */
function flatBody(delivery: PreviewSource): string {
  return foldUntrustedLine(delivery.body ?? "").trim();
}

/** The first sentence of `text`, or the whole of it when it has none. */
function firstSentence(text: string): string {
  const match = /^(.*?[.!?。！？])(?:\s|$)/u.exec(text);
  return match ? match[1]! : text;
}

/**
 * What the notice shows under a target for one message: `@sender: text`, folded to one line,
 * cut to its first sentence, capped at `INBOX_PREVIEW_MAX_CHARS`, and marked `(truncated)` when
 * either cut happened. A body's own `]` is escaped so it cannot read as the notice's closing
 * bracket; folding already keeps it from starting a line.
 */
export function inboxPreviewLine(delivery: PreviewSource): string | undefined {
  const flat = flatBody(delivery);
  if (!flat) return undefined;
  const sender = senderLabel(delivery);
  if (!sender) return undefined;
  const sentence = firstSentence(flat);
  const escaped = sentence.replaceAll("]", "\\]");
  const bounded = truncateCodePoints(escaped, INBOX_PREVIEW_MAX_CHARS);
  const truncated = sentence !== flat || bounded !== escaped;
  return `${sender}: ${bounded}${truncated ? TRUNCATED : ""}`;
}

/**
 * Whether the preview above is the whole message the model needs: the sender is a person or an
 * Agent, the target is not an attachment, the delivery is not a tracked mention, the server said
 * the message has no attachments (`attachmentCount` missing means unknown, never "none"), it is
 * not an App event, and nothing was cut. Only then may the daemon treat the message as shown.
 */
export function previewShowsWholeMessage(delivery: PreviewSource): boolean {
  if (!delivery.target || delivery.target.startsWith("attachment:")) return false;
  if (delivery.mentionDelivery !== undefined) return false;
  if (delivery.attachmentCount !== 0) return false;
  if (delivery.source === "app") return false;
  if (!senderLabel(delivery)) return false;
  const line = inboxPreviewLine(delivery);
  return line !== undefined && !line.endsWith(TRUNCATED);
}

/** `@handle` for a person or an Agent; a system notice and an invalid sender are not previewable. */
function senderLabel(delivery: PreviewSource): string | undefined {
  const kind = delivery.latestSenderKind;
  const handle = delivery.latestSenderHandle ?? "";
  if (kind !== "human" && kind !== "agent") return undefined;
  if (!isValidMessageSender(kind, handle)) return undefined;
  return `@${handle}`;
}
