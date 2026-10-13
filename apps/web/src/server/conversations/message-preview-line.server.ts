import {
  agentReadableBody,
  type MessageMentionRef,
} from "#src/server/conversations/mentions.server";

/** The longest one-line preview, in grapheme clusters (what a reader sees as characters),
 * including its trailing ellipsis. */
export const MESSAGE_PREVIEW_MAX_LENGTH = 120;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * A stored message body as one line of plain text for a list preview: mention and other tokens
 * read as the text a person writes, every run of whitespace (newlines included) becomes one space,
 * and a preview longer than the limit is cut with a trailing ellipsis. The cut falls between
 * grapheme clusters, so an emoji sequence, a flag or a skin-tone modifier is never split.
 * Markdown stays as written.
 */
export function messagePreviewLine(body: string, mentions: readonly MessageMentionRef[]): string {
  const line = agentReadableBody(body, mentions).replace(/\s+/gu, " ").trim();
  const characters = Array.from(graphemes.segment(line), (part) => part.segment);
  if (characters.length <= MESSAGE_PREVIEW_MAX_LENGTH) return line;
  return `${characters.slice(0, MESSAGE_PREVIEW_MAX_LENGTH - 1).join("")}…`;
}
