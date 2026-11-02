import { isRecord } from "@lrm/coforge-sdk/internal";
import {
  cardText,
  cardTexts,
  type PreviewCard,
} from "#src/features/conversations/action-card-preview";
import { Prisma } from "#src/generated/prisma/client";
import { FORWARDED_PREVIEW_SOURCE_LENGTH } from "./message-preview-line.server";

/** What a list read selects of a message's action card to preview it. */
export const ACTION_CARD_PREVIEW_SELECT = {
  select: { kind: true, payload: true, draftHint: true },
} as const;

export type StoredActionCard = {
  kind: string;
  payload: Prisma.JsonValue;
  draftHint: string | null;
};

/** The same, as one column of a raw list read that joins `action_cards card`: null for a message
 * that is no card. The Agent's note is cut like a forward's original, well over one line. */
export const ACTION_CARD_PREVIEW_COLUMN = Prisma.sql`CASE WHEN card."messageId" IS NOT NULL
  THEN jsonb_build_object('kind', card."kind", 'payload', card."payload",
    'draftHint', left(card."draftHint", ${FORWARDED_PREVIEW_SOURCE_LENGTH}::int)) END`;

/** The values a card's preview line names, from its stored payload. Undefined for a choice card,
 * whose body is already the question in the asker's own words, and for a payload without them (an
 * `add_member` card sent before its handles were kept), which previews as its stored body. */
function previewParams(kind: string, payload: Prisma.JsonValue): PreviewCard["params"] | undefined {
  if (!isRecord(payload)) return undefined;
  const all = (entries: Record<string, string | string[] | undefined>) =>
    Object.values(entries).every((value) => value !== undefined)
      ? (entries as PreviewCard["params"])
      : undefined;
  const prompt = cardText(payload.prompt);
  switch (kind) {
    case "channel:create":
    case "agent:create":
    case "app:register":
      return all({ name: cardText(payload.name) });
    case "channel:add_member":
      return all({
        channel: cardText(payload.channelHandle),
        members: cardTexts(payload.memberHandles),
      });
    case "app:recover_owner":
      return all({ agent: cardText(payload.toAgentName), app: cardText(payload.clientKey) });
    case "app:grant_agent":
      return all({ app: cardText(payload.appName), key: cardText(payload.appKey) });
    case "page:fill": {
      const fields = Array.isArray(payload.fields) ? payload.fields : [];
      const labels = cardTexts(fields.map((field) => (isRecord(field) ? field.label : undefined)));
      return all({ labels, ...(prompt ? { prompt } : {}) });
    }
    case "desktop:takeover":
      return prompt ? { prompt } : {};
    default:
      return undefined;
  }
}

/** A message's action card as its list previews it, or undefined when it has none to write in the
 * viewer's language (`previewParams`). The Agent's note is cut like a forward's original: well
 * over the one or two lines a list shows. */
export function previewCardOf(card: StoredActionCard | null | undefined): PreviewCard | undefined {
  if (!card) return undefined;
  const params = previewParams(card.kind, card.payload);
  if (!params) return undefined;
  // By code point, as SQL's `left` cuts, so no surrogate pair is split.
  const hint =
    card.draftHint && Array.from(card.draftHint).slice(0, FORWARDED_PREVIEW_SOURCE_LENGTH).join("");
  return { kind: card.kind, params, ...(hint ? { hint } : {}) };
}

/** The `card` field a list's message carries, from a read's joined card columns (null when the
 * message is no card). */
export function previewCardFieldOf(card: StoredActionCard | null | undefined): {
  card?: PreviewCard;
} {
  const preview = previewCardOf(card);
  return preview ? { card: preview } : {};
}
