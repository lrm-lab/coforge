/** Collapses newlines/whitespace runs to a single space and trims; used wherever user-written
 * identity text (displayName, description, name) is rendered inline so it cannot inject blank
 * lines or forge Markdown structure through whitespace alone. Exported for `agent-memory-seed.ts`,
 * which applies the same rule to the name rendered into the seeded MEMORY.md heading. */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
