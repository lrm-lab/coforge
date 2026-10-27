/** A Markdown file at least this long is rendered a few sections at a time; a shorter one at once. */
export const MARKDOWN_SECTIONED_MIN_LENGTH = 200_000;

// Only a heading at the start of a line cuts: one there always ends a list or quote above it,
// while an indented one may still belong to a list item.
const HEADING = /^#{1,3}(?:[ \t]|$)/;
// A fence may sit behind list or quote markers and any indent. A backtick fence's info string has
// no backtick (else the line is an inline code span), and a closing fence has no info string.
const FENCE = /^\s*(?:(?:[-*+]|\d{1,9}[.)])\s+|>\s*)*(`{3,}(?=[^`]*$)|~{3,})/;
const CLOSING_FENCE = /^\s*(?:>\s*)*(`{3,}|~{3,})[ \t]*$/;
// A link reference or footnote definition applies to the whole document, so a file with one is
// not split: a reference in one section to a definition in another would no longer resolve.
const DEFINITION = /^ {0,3}\[[^\]]+\]:/m;

/**
 * A long Markdown file cut before each h1–h3 heading, so its sections can be parsed and rendered
 * a few at a time; joined back, the parts are the file. A heading inside a fenced code block does
 * not cut it. A short file, or one with link reference or footnote definitions, stays one part.
 */
export function markdownSections(text: string): string[] {
  if (text.length < MARKDOWN_SECTIONED_MIN_LENGTH || DEFINITION.test(text)) return [text];
  const sections: string[] = [];
  let start = 0;
  let fence: string | undefined;
  let offset = 0;
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (fence) {
      const closer = CLOSING_FENCE.exec(line)?.[1];
      if (closer && closer[0] === fence[0] && closer.length >= fence.length) fence = undefined;
    } else {
      fence = FENCE.exec(line)?.[1];
      if (!fence && HEADING.test(line) && offset > start) {
        sections.push(text.slice(start, offset));
        start = offset;
      }
    }
    offset += raw.length + 1;
  }
  sections.push(text.slice(start));
  return sections;
}
