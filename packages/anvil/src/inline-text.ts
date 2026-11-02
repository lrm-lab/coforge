import { foldUntrustedLine } from "@lrm/coforge-sdk/internal";

/** Collapses newlines/whitespace runs to a single space and trims; used wherever user-written
 * identity text (displayName, description, name) is rendered inline so it cannot inject blank
 * lines or forge Markdown structure or a message line through whitespace alone. Every break a
 * reader honours counts, NEL and FS/GS/RS included (`foldUntrustedLine`). Exported for
 * `agent-memory-seed.ts`, which applies the same rule to the name rendered into the seeded
 * MEMORY.md heading. */
export function collapseWhitespace(text: string): string {
  return foldUntrustedLine(text);
}
