import { ANCHOR_DATA_MAX_BYTES } from "@lrm/coforge-sdk/agent";

export type TextQuote = { quote: string; prefix?: string; suffix?: string };

export type TextAnchorLimits = {
  dataMaxBytes: number;
  quoteChars: number;
  contextLengths: readonly number[];
  shortQuoteChars: number;
  contextMatchChars: number;
};

export const TEXT_ANCHOR_LIMITS: TextAnchorLimits = {
  dataMaxBytes: ANCHOR_DATA_MAX_BYTES,
  quoteChars: 4000,
  contextLengths: [64, 16, 0],
  shortQuoteChars: 12,
  contextMatchChars: 8,
};

export function createTextAnchors(limits: TextAnchorLimits) {
  const encoder = new TextEncoder();
  const byteLength = (value: unknown) => encoder.encode(JSON.stringify(value)).length;

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

  function joinPieces(pieces: readonly (readonly [text: string, block: unknown])[]) {
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

  function quoteAnchor(text: string, start: number, end: number): TextQuote | null {
    const span = trimmed(text, isLowSurrogate(text[start]) ? start - 1 : start, end);
    if (!span) return null;
    for (const context of limits.contextLengths) {
      let to = Math.min(span.end, span.start + limits.quoteChars);
      for (;;) {
        if (isHighSurrogate(text[to - 1])) to -= 1;
        const anchor: TextQuote = { quote: text.slice(span.start, to) };
        const prefix = contextBefore(text, span.start, context);
        const suffix = contextAfter(text, to, context);
        if (prefix) anchor.prefix = prefix;
        if (suffix) anchor.suffix = suffix;
        if (byteLength(anchor) <= limits.dataMaxBytes) return anchor;
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
    expected.length > 0 && shared >= Math.min(expected.length, limits.contextMatchChars);

  function findQuote(text: string, anchor: TextQuote): { start: number; end: number } | null {
    const { quote, prefix = "", suffix = "" } = anchor;
    if (quote === "") return null;
    const short = quote.length < limits.shortQuoteChars;
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

  function firstIndexWhere<T>(items: readonly T[], reached: (item: T) => boolean): number {
    let low = 0;
    let high = items.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (reached(items[middle]!)) high = middle;
      else low = middle + 1;
    }
    return low;
  }

  function clip(text: string, max: number) {
    if (text.length <= max) return text;
    let cut = text.slice(0, max - 1);
    if (isHighSurrogate(cut[cut.length - 1])) cut = cut.slice(0, -1);
    return cut + "…";
  }

  function collapsed(raw: string) {
    let text = "";
    const map = [0];
    let inRun = false;
    for (let i = 0; i < raw.length; i++) {
      if (/\s/.test(raw[i]!)) {
        if (!inRun) text += " ";
        inRun = true;
      } else {
        text += raw[i];
        inRun = false;
      }
      map.push(text.length);
    }
    return { text, map };
  }

  return { joinPieces, quoteAnchor, findQuote, firstIndexWhere, clip, collapsed };
}

export const { joinPieces, quoteAnchor, findQuote, firstIndexWhere, clip, collapsed } =
  createTextAnchors(TEXT_ANCHOR_LIMITS);
