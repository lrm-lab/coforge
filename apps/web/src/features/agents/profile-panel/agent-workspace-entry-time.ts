import { formatRelativeTime } from "#src/lib/dates";

/**
 * When a file last changed, as its row shows it ("12 min. ago"), so the reader sees what the Agent
 * touched lately. A folder shows nothing: its time moves only when an entry directly inside it is
 * added or removed, not when a file deeper down is edited, so it would read as stale while its
 * files are fresh. An unknown time (0) shows nothing either.
 */
export function workspaceEntryTime(
  entry: { type: string; modifiedAtMs: number },
  now: Date,
  locale: string,
): string | undefined {
  if (entry.type === "dir" || entry.modifiedAtMs <= 0) return undefined;
  return formatRelativeTime(new Date(entry.modifiedAtMs), now, locale);
}
