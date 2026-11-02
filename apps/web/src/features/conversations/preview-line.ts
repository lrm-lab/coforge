import type { Prisma } from "#src/generated/prisma/client";
import { systemNoticeText } from "./system-notice-text";

/** The longest one-line preview, in grapheme clusters (what a reader sees as characters),
 * including its trailing ellipsis. */
export const MESSAGE_PREVIEW_MAX_LENGTH = 120;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Text as one preview line: every run of whitespace (newlines included) becomes one space, and a
 * line longer than the limit is cut with a trailing ellipsis. The cut falls between grapheme
 * clusters, so an emoji sequence, a flag or a skin-tone modifier is never split. */
export function oneLine(text: string): string {
  const line = text.replace(/\s+/gu, " ").trim();
  const characters = Array.from(graphemes.segment(line), (part) => part.segment);
  if (characters.length <= MESSAGE_PREVIEW_MAX_LENGTH) return line;
  return `${characters.slice(0, MESSAGE_PREVIEW_MAX_LENGTH - 1).join("")}…`;
}

/** The structured content a list carries beside a preview whose message is a system notice: the
 * stored kind and params, which a server function returns as they are read. */
export type PreviewNotice = { kind: string; params: Prisma.JsonValue };

/** A list's preview as the viewer reads it: a system notice rendered in their language, cut to
 * one line like any preview; any other message as the server wrote it. */
export function previewText(preview: string, notice?: PreviewNotice | null): string {
  return notice ? oneLine(systemNoticeText({ body: preview, system: notice })) : preview;
}

/** The `notice` field a list's last message carries, from a read's joined notice columns: present
 * only when the message is a system notice. */
export function previewNoticeOf(
  kind: string | null,
  params: Prisma.JsonValue | undefined,
): { notice?: PreviewNotice } {
  return kind ? { notice: { kind, params: params ?? null } } : {};
}
