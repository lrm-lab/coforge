/**
 * Text an Agent reads that someone else wrote (a message, a name, a title, a description, a file
 * name, an app's event) must never start a line of its own: a line that begins
 * `[target=... msg=...]` reads as a new message. It is framed, not escaped, as Raft 1.0.59 does:
 * a multi-line body keeps its lines, each continuation behind the `  │ ` gutter, and a one-line
 * field is folded to one line. Breaks are matched as broadly as any reader honours them.
 */

/** Every break a terminal, a Markdown reader or a model may start a new line on; CRLF is one. */
export const UNTRUSTED_LINE_BREAKS = [
  "\r\n",
  "\n",
  "\r",
  "\v",
  "\f",
  "\x1c",
  "\x1d",
  "\x1e",
  "\x85",
  "\u2028",
  "\u2029",
] as const;

/** `UNTRUSTED_LINE_BREAKS` as one pattern, for splitting a body into its lines. */
export const MESSAGE_LINE_SEPARATOR = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/u;

/** What starts each continuation line of a framed body. */
export const UNTRUSTED_CONTINUATION = "  │ ";

/** A multi-line body as an Agent reads it: its first line where it stands, each further line
 * behind the gutter, so none of them can pass for output of its own. */
export function frameUntrustedText(text: string): string {
  return text.split(MESSAGE_LINE_SEPARATOR).join(`\n${UNTRUSTED_CONTINUATION}`);
}

/** Whitespace and every break, including the ones `\s` leaves out (NEL, FS, GS, RS). */
const FOLDABLE = /(?:\s|[\x1c\x1d\x1e\x85])+/gu;

/** A one-line field (a name, a title, a file name) as an Agent reads it: every run of whitespace
 * or breaks is one space, and none is left at either end. */
export function foldUntrustedLine(text: string): string {
  return text.replace(FOLDABLE, " ").trim();
}
