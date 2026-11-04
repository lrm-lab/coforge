/**
 * Where a body's prose references were written: Markdown parsing drops or rewrites syntax (an
 * escaped `<`, a character reference, a quote's `>`), so a reference's offset in the parsed text is
 * mapped back to the body it came from. Split from `message-references.ts`, which owns what the
 * references mean.
 */
import type { Nodes, Text } from "mdast";
import { decodeNamedCharacterReference } from "decode-named-character-reference";
import { decodeNumericCharacterReference } from "micromark-util-decode-numeric-character-reference";

/** A character reference in Markdown source (`&amp;`, `&#35;`, `&#x23;`), tried only at `&`. */
const CHARACTER_REFERENCE =
  /&(?:#([0-9]{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{0,31}));/y;

/** ASCII punctuation: what a backslash escapes in Markdown. */
const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;

/** Syntax whose text is never prose: code, links and their definitions, and raw HTML. */
const NOT_PROSE = new Set<Nodes["type"]>([
  "code",
  "inlineCode",
  "link",
  "linkReference",
  "definition",
  "html",
]);

/**
 * Maps source offsets in reading order back to the body. Only an escaped `<` adds source units;
 * code spans, autolinks and literal entities keep their original lengths. Read the actual source
 * instead of repeating the escaping rules, and retain only the next `<` and expansion so far.
 */
export function bodyOffsets(body: string, source: string): (offset: number) => number {
  let next = body.indexOf("<");
  let expansion = 0;
  return (offset) => {
    while (next !== -1 && next + expansion < offset) {
      const start = next + expansion;
      if (source.startsWith("&lt;", start)) {
        if (offset < start + 4) return next;
        expansion += 3;
      }
      next = body.indexOf("<", next + 1);
    }
    return offset - expansion;
  };
}

export type SourceRange = { start: number; end: number };

/** Positioned literal text maps from one start; other text maps each code unit. */
export type TextAlignment = { starts: number | number[]; end: number };

/**
 * The prose `text` nodes of a tree, in document order, each with the source range of its nearest
 * positioned ancestor. GFM's autolink-literal transform splits text around a bare URL or email
 * address into new nodes that carry no position; such a node is found inside that range.
 */
export function proseTextNodes(
  tree: Nodes,
  within: SourceRange | undefined,
): { node: Text; within: SourceRange | undefined }[] {
  const start = tree.position?.start.offset;
  const end = tree.position?.end.offset;
  const range = start !== undefined && end !== undefined ? { start, end } : within;
  if (tree.type === "text") return [{ node: tree, within }];
  if (NOT_PROSE.has(tree.type) || !("children" in tree)) return [];
  return tree.children.flatMap((child) => proseTextNodes(child, range));
}

/**
 * Where a text node's characters were written in `source`, and where it ends. A positioned node
 * is aligned from its own start; a node with no position at the first offset, from `cursor` on
 * inside its ancestor's range, where its whole value aligns. `undefined` when it cannot be
 * aligned; its references are then left as written.
 */
export function alignNode(
  source: string,
  node: Text,
  within: SourceRange | undefined,
  cursor: number,
): TextAlignment | undefined {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start !== undefined && end !== undefined) {
    const value = node.value;
    if (
      value.length >= 128 &&
      start + value.length <= end &&
      source.startsWith(value, start) &&
      !value.includes("&") &&
      !value.includes("\\")
    )
      return { starts: start, end: start + value.length };
    return sourceStarts(source, value, start, end);
  }
  if (!within) return undefined;
  for (let from = Math.max(cursor, within.start); from < within.end; from += 1) {
    const aligned = sourceStarts(source, node.value, from, within.end);
    if (aligned) return aligned;
  }
  return undefined;
}

/**
 * Where each character of `value` begins in `source`, aligned from `from` and within `to`: the
 * character itself, the `\` of an escape, or the `&` of a character reference; and the offset
 * after the last one.
 *
 * What the parser dropped belongs to no character: whitespace (a line's trailing spaces) and, at
 * the start of a continuation line, its indentation and container markers — a quote's `>`
 * (nested, indented, inside a list item). A list item's continuation lines carry only indentation
 * and a table cell never spans lines, so a quote marker is the only non-whitespace syntax a
 * continuation line drops. How much of a line's leading `>`/whitespace run is syntax is decided per
 * line: the shortest prefix after which the whole line aligns.
 */
function sourceStarts(
  source: string,
  value: string,
  from: number,
  to: number,
): { starts: number[]; end: number } | undefined {
  const starts: number[] = [];
  let offset = from;
  let index = 0;
  while (index < value.length) {
    // One line of the value at a time: its prefix, then its characters up to its line ending.
    const lineEnd = value.indexOf("\n", index);
    const last = lineEnd === -1 ? value.length : lineEnd + 1;
    let aligned: number | undefined;
    if (index === 0) aligned = alignLine(source, offset, to, value, index, last, starts);
    else {
      let prefix = offset;
      while (prefix < to && /[ \t>]/.test(source[prefix]!)) prefix += 1;
      for (let start = offset; start <= prefix && aligned === undefined; start += 1)
        aligned = alignLine(source, start, to, value, index, last, starts);
    }
    if (aligned === undefined) return undefined;
    offset = aligned;
    index = last;
  }
  return { starts, end: offset };
}

/**
 * Aligns value characters `[index, last)` from source offset `offset`, recording where each
 * begins; the source offset after the last one, or `undefined` when they do not align.
 */
function alignLine(
  source: string,
  offset: number,
  to: number,
  value: string,
  index: number,
  last: number,
  starts: number[],
): number | undefined {
  while (index < last) {
    if (offset >= to) return undefined;
    const character = source[offset]!;
    const reference = character === "&" ? characterReferenceAt(source, offset, to) : undefined;
    if (reference && value.startsWith(reference.decoded, index)) {
      for (let unit = 0; unit < reference.decoded.length; unit += 1) starts[index + unit] = offset;
      index += reference.decoded.length;
      offset += reference.text.length;
    } else if (
      character === "\\" &&
      ASCII_PUNCTUATION.test(source[offset + 1] ?? "") &&
      source[offset + 1] === value[index]
    ) {
      // A backslash escape: the pair is one character of the value.
      starts[index] = offset;
      index += 1;
      offset += 2;
    } else if (character === value[index]) {
      starts[index] = offset;
      index += 1;
      offset += 1;
    } else if (/\s/.test(character)) {
      offset += 1;
    } else {
      return undefined;
    }
  }
  return offset;
}

/**
 * The character reference written at `offset` and what it decodes to, when one ends by `to` —
 * decoded with the parser's own decoders, so a reference that decodes to several characters
 * aligns exactly. An unknown name (`&nope;`) is not a reference.
 */
function characterReferenceAt(
  source: string,
  offset: number,
  to: number,
): { text: string; decoded: string } | undefined {
  CHARACTER_REFERENCE.lastIndex = offset;
  const match = CHARACTER_REFERENCE.exec(source);
  if (!match || offset + match[0].length > to) return undefined;
  const decoded =
    match[1] !== undefined
      ? decodeNumericCharacterReference(match[1], 10)
      : match[2] !== undefined
        ? decodeNumericCharacterReference(match[2], 16)
        : decodeNamedCharacterReference(match[3]!);
  return decoded === false ? undefined : { text: match[0], decoded };
}
