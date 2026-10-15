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
  const indexed = rows.map((row, index) => ({ row, index, at: instantOf(row.lastMessageAt) }));
  indexed.sort((left, right) => {
    const order =
      mode === "alpha"
        ? collator.compare(left.row.name, right.row.name)
        : newerFirst(left.at, right.at);
    return order || left.index - right.index;
  });
  return indexed.map(({ row }) => row.key);
}

/** The last message's time; `null` when the row has none or the value is not an ISO instant. */
function instantOf(value: string | null): Temporal.Instant | null {
  if (!value) return null;
  try {
    return Temporal.Instant.from(value);
  } catch {
    return null;
  }
}

/** Latest first; a row without a time goes after every row with one. */
function newerFirst(left: Temporal.Instant | null, right: Temporal.Instant | null): number {
  if (!left || !right) return left ? -1 : right ? 1 : 0;
  return Temporal.Instant.compare(right, left);
}
