/**
 * The distinct whitespace-separated terms of a search query, compared case-insensitively. The
 * server requires every term in a matching message's stored body (mention tokens included); the
 * results page highlights them in the rendered text.
 */
export function searchTerms(query: string): string[] {
  const seen = new Set<string>();
  return query.split(/\s+/).filter((term) => {
    const key = term.toLowerCase();
    if (!term || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The `ILIKE` pattern of a text containing `term` literally. */
export function containsPattern(term: string): string {
  return `%${escapeLikeTerm(term)}%`;
}

/** `ILIKE` treats `\`, `%` and `_` as syntax; escape them so a term matches literally. */
export function escapeLikeTerm(term: string): string {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}
