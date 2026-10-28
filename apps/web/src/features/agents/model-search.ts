/** One choice of the model field: what it shows, and what a search may match besides that. */
export interface ModelChoice {
  id: string;
  label: string;
  /** Matched by a search but not shown: the model's id and description. */
  keywords?: readonly string[];
}

/**
 * The model choices a search shows, in the runtime's order: every choice whose label or keywords
 * contain `query` (case-insensitive), plus `pinned` (the default and "Custom…" entries), which a
 * search never hides. An empty query shows everything.
 */
export function searchModelChoices(
  choices: readonly ModelChoice[],
  query: string,
  pinned: ReadonlySet<string>,
): ModelChoice[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...choices];
  return choices.filter(
    (choice) =>
      pinned.has(choice.id) ||
      [choice.label, ...(choice.keywords ?? [])].some((text) =>
        text.toLocaleLowerCase().includes(needle),
      ),
  );
}
