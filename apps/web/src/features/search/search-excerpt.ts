export type ExcerptPart = { text: string; match: boolean };

/** Characters kept before the first match, so the match stays inside a two-line excerpt. */
const LEAD = 40;

/**
 * A result's excerpt: the text starting a little before the first match (with an ellipsis when
 * cut), split into parts where each term match is flagged, case-insensitively.
 */
export function searchExcerpt(text: string, terms: string[]): ExcerptPart[] {
  const flat = text.replace(/\s+/g, " ").trim();
  if (terms.length === 0) return [{ text: flat, match: false }];
  const pattern = new RegExp(
    // Longest first, so a term that contains another (`ab` and `a`) is marked whole.
    `(${[...terms]
      .sort((a, b) => b.length - a.length)
      .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|")})`,
    "gi",
  );
  const first = flat.search(pattern);
  const start = first > LEAD ? first - LEAD : 0;
  const shown = start > 0 ? `…${flat.slice(start)}` : flat;
  const lowerTerms = terms.map((term) => term.toLowerCase());
  // Unicode regexp case matching can differ from lowercase equality.
  if (terms.every((term) => /^[\x20-\x7e]*$/.test(term))) {
    const parts = shown.split(pattern);
    const excerpt: ExcerptPart[] = [];
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index]!;
      if (!part) continue;
      // One capture and ASCII literals under gi make odd split entries definite hits.
      excerpt.push({
        text: part,
        match: index % 2 === 1 || lowerTerms.includes(part.toLowerCase()),
      });
    }
    return excerpt;
  }
  return shown
    .split(pattern)
    .filter(Boolean)
    .map((part) => ({
      text: part,
      match: lowerTerms.includes(part.toLowerCase()),
    }));
}
