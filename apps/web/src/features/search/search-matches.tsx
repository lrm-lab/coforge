import { searchExcerpt } from "./search-excerpt";

/** The class of a found word: violet, as a reference in a message, never heavier black. */
const SEARCH_MATCH_CLASS = "bg-transparent font-medium text-(--color-reference-text)";

/** `text` around its found words, each marked. */
export function SearchMatches({
  text,
  terms,
  lead,
}: {
  text: string;
  terms: string[];
  lead?: number;
}) {
  return searchExcerpt(text, terms, lead).map((part, index) =>
    part.match ? (
      <mark key={index} className={SEARCH_MATCH_CLASS}>
        {part.text}
      </mark>
    ) : (
      part.text
    ),
  );
}
