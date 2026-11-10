import { useEffect } from "react";

// The Activity items being read on screen right now (`conversation:<id>`, `thread:<rootId>`), as
// counts: a conversation and its thread can each be registered by more than one mounted pane.
const viewing = new Map<string, number>();

/**
 * Registers an Activity item as read on screen for as long as the caller is mounted and passes
 * its key; `undefined` registers nothing. Callers pass the key exactly while their own read runs
 * (open, a member, the window in front with focus), so a message there is not counted as unread.
 */
export function useReportViewingItem(key: string | undefined) {
  useEffect(() => {
    if (key === undefined) return;
    viewing.set(key, (viewing.get(key) ?? 0) + 1);
    return () => {
      const left = (viewing.get(key) ?? 1) - 1;
      if (left > 0) viewing.set(key, left);
      else viewing.delete(key);
    };
  }, [key]);
}

/** Whether the item is read on screen right now. */
export function isViewingItem(key: string): boolean {
  return viewing.has(key);
}
