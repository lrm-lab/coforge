import type { ChatSectionSortMode } from "./chat-section.schemas";

/** What a section's sort reads from a row: its shown name and its last message time. */
export type SortableRow = { key: string; name: string; lastMessageAt: string | null };

/**
 * A custom section's rows in its chosen order. Manual keeps the drag order (`rows` as given);
 * Recent puts the latest message first, rows without a message last; A-Z compares names the way
 * the reader's language does. Ties keep the drag order, so a change of mode never shuffles rows
 * that compare equal.
 */
export function sortSectionRows(
  rows: readonly SortableRow[],
  mode: ChatSectionSortMode,
  locale?: string,
): string[] {
  if (mode === "manual") return rows.map((row) => row.key);
  const collator = new Intl.Collator(locale, { sensitivity: "base", numeric: true });
  const indexed = rows.map((row, index) => ({ row, index }));
  indexed.sort((left, right) => {
    const order =
      mode === "alpha"
        ? collator.compare(left.row.name, right.row.name)
        : recency(right.row) - recency(left.row);
    return order || left.index - right.index;
  });
  return indexed.map(({ row }) => row.key);
}

function recency(row: SortableRow): number {
  if (!row.lastMessageAt) return Number.NEGATIVE_INFINITY;
  const time = Date.parse(row.lastMessageAt);
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}
