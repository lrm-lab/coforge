import { useEffect } from "react";

// The Activity items being read on screen right now, one entry per mounted pane that reads one:
// a conversation and its thread can each be read by more than one pane at once.
let viewing: { key: string }[] = [];

/**
 * Registers an Activity item (`activityItemKey`) as read on screen for as long as the caller is
 * mounted and passes its key; `undefined` registers nothing. Callers pass the key exactly while
 * their own read runs (open, a member, the window in front with focus), so a message there is not
 * counted as unread.
 */
export function useReportViewingItem(key: string | undefined) {
  useEffect(() => {
    if (key === undefined) return;
    const entry = { key };
    viewing = [...viewing, entry];
    return () => {
      viewing = viewing.filter((it) => it !== entry);
    };
  }, [key]);
}

/** Whether the item is read on screen right now. */
export function isViewingItem(key: string): boolean {
  return viewing.some((it) => it.key === key);
}
