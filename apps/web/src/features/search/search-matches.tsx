import { searchExcerpt } from "./search-excerpt";

/** The class of a found word: the brand color, never heavier black. */
export const SEARCH_MATCH_CLASS = "bg-transparent font-medium text-brand-600 dark:text-brand-400";

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
