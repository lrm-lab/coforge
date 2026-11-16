import { ANCHOR_DATA_MAX_BYTES } from "@lrm/coforge-sdk/agent";

export type TextQuote = { quote: string; prefix?: string; suffix?: string };

const CONTEXT_LENGTHS = [64, 16, 0];

const encoder = new TextEncoder();

const byteLength = (value: unknown) => encoder.encode(JSON.stringify(value)).length;

const SHORT_QUOTE_CHARS = 12;
const CONTEXT_MATCH_CHARS = 8;

const isHighSurrogate = (char: string | undefined) => {
  const code = char?.charCodeAt(0) ?? 0;
  return code >= 0xd800 && code <= 0xdbff;
};

const isLowSurrogate = (char: string | undefined) => {
  const code = char?.charCodeAt(0) ?? 0;
  return code >= 0xdc00 && code <= 0xdfff;
};

const contextBefore = (text: string, at: number, length: number) => {
  let from = Math.max(0, at - length);
  if (isLowSurrogate(text[from])) from += 1;
  return text.slice(from, at);
};

const contextAfter = (text: string, at: number, length: number) => {
  let to = Math.min(text.length, at + length);
  if (to > at && isHighSurrogate(text[to - 1])) to -= 1;
  return text.slice(at, to);
};

export function joinPieces(pieces: readonly (readonly [text: string, block: unknown])[]) {
  let text = "";
  let previous: unknown;
  const starts = pieces.map(([piece, block], index) => {
    if (index > 0 && block !== previous) text += "\n";
    const start = text.length;
    text += piece;
    previous = block;
    return start;
  });
  return { text, starts };
}

function trimmed(text: string, start: number, end: number) {
  let from = start;
  let to = end;
  while (from < to && /\s/.test(text[from]!)) from += 1;
  while (to > from && /\s/.test(text[to - 1]!)) to -= 1;
  return from < to ? { start: from, end: to } : null;
}

export function quoteAnchor(text: string, start: number, end: number): TextQuote | null {
  const span = trimmed(text, isLowSurrogate(text[start]) ? start - 1 : start, end);
  if (!span) return null;
  for (const context of CONTEXT_LENGTHS) {
    let to = Math.min(span.end, span.start + 4000);
    for (;;) {
      if (isHighSurrogate(text[to - 1])) to -= 1;
      const anchor: TextQuote = { quote: text.slice(span.start, to) };
      const prefix = contextBefore(text, span.start, context);
      const suffix = contextAfter(text, to, context);
      if (prefix) anchor.prefix = prefix;
      if (suffix) anchor.suffix = suffix;
      if (byteLength(anchor) <= ANCHOR_DATA_MAX_BYTES) return anchor;
      to = span.start + Math.floor((to - span.start) * 0.9);
      if (to <= span.start) break;
    }
  }
  return null;
}

const sharedSuffix = (text: string, expected: string) => {
  let length = 0;
  while (
    length < text.length &&
    length < expected.length &&
    text[text.length - 1 - length] === expected[expected.length - 1 - length]
  )
    length += 1;
  return length;
};

const sharedPrefix = (text: string, expected: string) => {
  let length = 0;
  while (length < text.length && length < expected.length && text[length] === expected[length])
    length += 1;
  return length;
};

const contextMatches = (shared: number, expected: string) =>
  expected.length > 0 && shared >= Math.min(expected.length, CONTEXT_MATCH_CHARS);

export function findQuote(text: string, anchor: TextQuote): { start: number; end: number } | null {
  const { quote, prefix = "", suffix = "" } = anchor;
  if (quote === "") return null;
  const short = quote.length < SHORT_QUOTE_CHARS;
  const hasContext = prefix !== "" || suffix !== "";
  let best: { start: number; score: number } | null = null;
  let occurrences = 0;
  for (let at = text.indexOf(quote); at !== -1; at = text.indexOf(quote, at + 1)) {
    occurrences += 1;
    const end = at + quote.length;
    const before = sharedSuffix(text.slice(Math.max(0, at - prefix.length), at), prefix);
    const after = sharedPrefix(text.slice(end, end + suffix.length), suffix);
    if (short && hasContext && !contextMatches(before, prefix) && !contextMatches(after, suffix))
      continue;
    const score = before + after;
    if (best === null || score > best.score) best = { start: at, score };
  }
  if (short && !hasContext && occurrences > 1) return null;
  return best && { start: best.start, end: best.start + quote.length };
}

export function firstIndexWhere<T>(items: readonly T[], reached: (item: T) => boolean): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (reached(items[middle]!)) high = middle;
    else low = middle + 1;
  }
  return low;
}
