import { readableBody } from "@lrm/coforge-sdk/internal";
import type { MessageMentionRef } from "#src/server/conversations/mentions.server";

/** A mention as a list preview reads it: `label` is the name a person is shown by
 * (`browserMessageMention`); an Agent reads as its `@handle`, how an Agent is mentioned. */
export type PreviewMentionRef = MessageMentionRef & { label: string };

/** The longest one-line preview, in grapheme clusters (what a reader sees as characters),
 * including its trailing ellipsis. */
export const MESSAGE_PREVIEW_MAX_LENGTH = 120;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * A stored message body as one line of plain text for a list preview: a person's mention reads as
 * their name (never their username), an Agent's as its `@handle`, other tokens as the text a person
 * writes, every run of whitespace (newlines included) becomes one space,
 * and a preview longer than the limit is cut with a trailing ellipsis. The cut falls between
 * grapheme clusters, so an emoji sequence, a flag or a skin-tone modifier is never split.
 * Markdown stays as written.
 */
export function messagePreviewLine(body: string, mentions: readonly PreviewMentionRef[]): string {
  const readable = readableBody(body, {
    mention: (type, id) => {
      const mention = mentions.find((row) => row.kind === type && row.actorId.toLowerCase() === id);
      return mention && (mention.kind === "user" ? mention.label : mention.handle);
    },
  });
  const line = readable.replace(/\s+/gu, " ").trim();
  const characters = Array.from(graphemes.segment(line), (part) => part.segment);
  if (characters.length <= MESSAGE_PREVIEW_MAX_LENGTH) return line;
  return `${characters.slice(0, MESSAGE_PREVIEW_MAX_LENGTH - 1).join("")}…`;
}
