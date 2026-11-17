/**
 * A message body longer than the server takes is sent as a Markdown file instead of failing
 * (task #coforge-designer-team:#138): the full text goes in the file, the message keeps its first
 * lines as a preview with a note pointing at the file. The Web composer and the CLI
 * (`coforge message send`, `coforge task reply`, task #coforge-backend:#42) share this one rule,
 * so a long message reads the same whoever sent it.
 */

import { mentionsInContent } from "./mentions";

/** The longest message body the server takes, in UTF-16 code units of the trimmed body. */
export const MESSAGE_BODY_MAX_LENGTH = 8_000;

/** The preview keeps at most this many lines of the body... */
export const LONG_MESSAGE_PREVIEW_LINES = 5;
/** ...and at most this many characters of them. */
export const LONG_MESSAGE_PREVIEW_CHARS = 400;

/** Whether `body` is too long to send as a message (the server trims before it measures). */
export function isLongMessage(body: string): boolean {
  return body.trim().length > MESSAGE_BODY_MAX_LENGTH;
}

const pad = (value: number) => String(value).padStart(2, "0");

/**
 * The file and the message a long body becomes. `note` is the line under the preview, in the
 * sender's language (the Web passes its translation, the CLI its own); `now` names the file by
 * the sender's local time, e.g. `message-20261117-153012.md`. Every `@handle` the full text names
 * past the preview follows the note on a line of its own, so whoever the message mentions is
 * still notified, as a message, not only inside the file.
 */
export function longMessageAsFile(
  body: string,
  { note, now }: { note: string; now: Date },
): { preview: string; fileName: string; content: string } {
  const text = body.trim();
  const allLines = text.split("\n");
  let preview = allLines.slice(0, LONG_MESSAGE_PREVIEW_LINES).join("\n");
  const cut =
    preview.length > LONG_MESSAGE_PREVIEW_CHARS || allLines.length > LONG_MESSAGE_PREVIEW_LINES;
  if (preview.length > LONG_MESSAGE_PREVIEW_CHARS) {
    // Never split a surrogate pair: an emoji cut in half would show as a broken glyph.
    let end = LONG_MESSAGE_PREVIEW_CHARS;
    const code = preview.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    preview = preview.slice(0, end);
  }
  preview = preview.trimEnd();
  if (cut) preview += "…";
  // A preview that stops inside a code block would swallow the note into it.
  const fences = preview.split("\n").filter((line) => line.trimStart().startsWith("```")).length;
  if (fences % 2 === 1) preview += "\n```";
  const fileName = `message-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.md`;
  const shown = mentionsInContent(preview);
  const rest = [...mentionsInContent(text)].filter((handle) => !shown.has(handle));
  const mentions = rest.length > 0 ? `\n${rest.map((handle) => `@${handle}`).join(" ")}` : "";
  return { preview: `${preview}\n\n${note}${mentions}`, fileName, content: `${text}\n` };
}
