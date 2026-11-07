import { useEffect, useRef, useState } from "react";

/** How long a card takes to fade and fold away; `usage-limit-notice-list` animates to match. */
export const NOTICE_LEAVE_MS = 200;

/**
 * `items` plus the ones that just left, marked `leaving` in their old place for `NOTICE_LEAVE_MS`,
 * so a card that goes (dismissed, or its usage reset) can animate out instead of vanishing.
 */
export function useLeavingItems<T extends { id: string }>(items: readonly T[]) {
  const [leaving, setLeaving] = useState<readonly { item: T; index: number }[]>([]);
  const previous = useRef(items);
  useEffect(() => {
    const gone = previous.current.flatMap((item, index) =>
      items.some((each) => each.id === item.id) ? [] : [{ item, index }],
    );
    previous.current = items;
    if (gone.length === 0) return;
    setLeaving((current) => [...current, ...gone]);
    const ids = gone.map(({ item }) => item.id);
    window.setTimeout(
      () => setLeaving((current) => current.filter(({ item }) => !ids.includes(item.id))),
      NOTICE_LEAVE_MS,
    );
  }, [items]);
  const rows = items.map((item) => ({ item, leaving: false }));
  for (const { item, index } of leaving)
    rows.splice(Math.min(index, rows.length), 0, { item, leaving: true });
  return rows;
}
