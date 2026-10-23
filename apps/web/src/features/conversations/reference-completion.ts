/**
 * Pure text logic for the composer's reference completion, free of React and DOM types: which
 * in-progress `@name` or `#channel` token sits at the caret, which channels a `#query` offers,
 * and how a chosen reference is spliced into the draft. Mention ranking lives next to the
 * mention grammar in `mention-text.ts`; the send-time recognizer (`lib/message-references.ts`)
 * turns the inserted plain text into structured tokens, so completion only ever writes text.
 */

/** The character that opened a completion: `@` for a mention, `#` for a channel. */
export type ReferenceTrigger = "@" | "#";

/** One channel the `#` list can offer: the messages layout's every-channel list (archived and
 * closed ones included), with the description shown as the row's second line. */
export type ChannelSuggestion = {
  id: string;
  name: string;
  description: string;
  archived: boolean;
};

/**
 * Whether text ending at the caret is inside code, in the grammar `splitCodeSpans` applies to a
 * sent body (fenced blocks first, then single-line inline spans), read on a draft that may still
 * be open: an odd number of ``` fences means an unclosed block, and otherwise an odd number of
 * backticks on the caret's line after the last fence means an unclosed inline span. A reference
 * is never recognized inside code, so completion does not open there.
 */
function caretInCode(beforeCaret: string): boolean {
  let fenced = false;
  let lastFenceEnd = 0;
  for (
    let fence = beforeCaret.indexOf("```");
    fence !== -1;
    fence = beforeCaret.indexOf("```", lastFenceEnd)
  ) {
    fenced = !fenced;
    // Match split's nonoverlapping triples, including runs longer than three backticks.
    lastFenceEnd = fence + 3;
  }
  if (fenced) return true;

  const lineStart = Math.max(lastFenceEnd, beforeCaret.lastIndexOf("\n") + 1);
  let inline = false;
  for (
    let tick = beforeCaret.indexOf("`", lineStart);
    tick !== -1;
    tick = beforeCaret.indexOf("`", tick + 1)
  ) {
    inline = !inline;
  }
  return inline;
}

/** An `@query` (any run without whitespace, `@`, `＠` or `#`) or a `#query` (channel-name
 * characters), at the text start or after a boundary character (see `activeReferenceQuery`),
 * running to the caret. */
// The boundary is an assertion so matches can start at the trigger itself.
const REFERENCE_QUERY = /(?<![A-Za-z0-9._%+@＠#/:?=&~-])(?:[@＠]([^\s@＠#]*)|#([a-z0-9_-]*))$/;

/**
 * The completion query at the caret: the in-progress token starts at `@` or `#` (at the text
 * start or after a boundary character, below) and runs to the caret. The full-width `＠`
 * (U+FF20, what a Chinese IME types in punctuation mode) is the same trigger as `@` with the same
 * rules and reports trigger `"@"`; `insertReference` replaces it, so a picked mention reads `@name`.
 * A typed-but-unpicked `＠name` stays plain text at send. A `#query` uses
 * channel-name characters only; an `@query` is a person's or Agent's name as it reads, so any run
 * of characters that are not whitespace, `@`, `＠` or `#` — a CJK or capitalized name opens the list
 * too, while a space still ends it (a name is picked from the list, not typed out with its
 * spaces).
 * Returns the trigger, the token's start offset (the trigger itself) and the typed query without
 * it. `undefined` when the caret is not inside such a token — e.g. straight after an ASCII word,
 * inside an email address or a URL, past a completed reference followed by more name characters,
 * or in code.
 *
 * Both triggers open at the text start or after any character except an ASCII letter or digit,
 * the email local-part characters `._%+-`, the URL characters `/:?=&~`, or another `@`, `＠` or `#`
 * (Frank's decision in task #49): Chinese puts no space between words, so `你好@`, `（@`, `：@`
 * and `去#ra` open the list, while `a@b.com`, `foo.bar@`, `C#`, `https://x.com/@frank` and
 * `https://x.com/docs/#install` stay plain text. The send-time recognizers exclude fewer
 * characters before a trigger, so they still read whatever completion writes: `mention-pins.ts`'s
 * `WORD_BEFORE` for a pinned `@label`, the SDK's `MENTION_PATTERN` for an `@handle`, and
 * `CHANNEL_REFERENCE_PATTERN` for a `#channel`. Completion only decides when to offer help.
 */
export function activeReferenceQuery(
  value: string,
  caret: number,
): { trigger: ReferenceTrigger; start: number; query: string } | undefined {
  const beforeCaret = value.slice(0, caret);
  const match = REFERENCE_QUERY.exec(beforeCaret);
  const query = match?.[1] ?? match?.[2];
  if (query === undefined || caretInCode(beforeCaret)) return undefined;
  return { trigger: match?.[1] !== undefined ? "@" : "#", start: caret - query.length - 1, query };
}

/**
 * The channels a `#query` offers: every channel whose name contains the query
 * (case-insensitively), the current conversation's channel first when it matches, then the rest
 * alphabetically by name. Archived channels stay in the list; the row marks them. Capped by
 * `limit`.
 */
export function filterChannelSuggestions(
  channels: readonly ChannelSuggestion[],
  query: string,
  options: { currentChannelId?: string; limit?: number } = {},
): ChannelSuggestion[] {
  const { currentChannelId, limit = 8 } = options;
  const lowerQuery = query.toLowerCase();
  return channels
    .filter((channel) => channel.name.toLowerCase().includes(lowerQuery))
    .sort(
      (left, right) =>
        Number(right.id === currentChannelId) - Number(left.id === currentChannelId) ||
        left.name.localeCompare(right.name),
    )
    .slice(0, limit);
}

/**
 * Replace the in-progress token `[start, caret)` with `text` and a trailing space, and return the
 * new value and caret position (after the space, which keeps a completed reference from
 * re-opening the completion). When a space or tab already follows the token, that one is the
 * trailing space: none is added, and the caret moves past it. A line break is not reused, so the
 * caret stays on the reference's line.
 */
export function insertReference(
  value: string,
  start: number,
  caret: number,
  text: string,
): { value: string; caret: number } {
  const after = value.slice(caret);
  const spaced = after.startsWith(" ") || after.startsWith("\t");
  const next = value.slice(0, start) + text + (spaced ? "" : " ") + after;
  return { value: next, caret: start + text.length + 1 };
}
