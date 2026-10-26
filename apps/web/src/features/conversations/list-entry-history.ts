import { useEffect, useMemo } from "react";
import { useRouter } from "@tanstack/react-router";

import { browserSessionStorage } from "#src/features/browser-session-storage";

/** Where a page keeps the history index of its list's entry, by the page's path. */
function listEntryKey(pathname: string) {
  return `coforge:list-entry:${pathname}`;
}

/**
 * History for a page whose conversation (`open` in its URL) takes the place of its list on a
 * narrow screen (Activity, Search): opening one from the list pushes an entry, so a phone's back
 * gesture returns to the list, and closing it goes back to the list's entry, past what the
 * conversation pushed (a thread, a profile), rather than stacking a copy of the list. The list's
 * entry is kept in session storage, so a reload keeps that way back; it is forgotten once the list
 * shows again or the app leaves the page.
 */
export function useListEntryHistory(open: string | undefined) {
  const router = useRouter();
  useEffect(() => {
    if (open === undefined) forgetListEntry(router.latestLocation.pathname);
  }, [open, router]);
  useEffect(
    () =>
      router.subscribe("onBeforeNavigate", ({ fromLocation, toLocation }) => {
        if (fromLocation && toLocation.pathname !== fromLocation.pathname)
          forgetListEntry(fromLocation.pathname);
      }),
    [router],
  );
  return useMemo(
    () => ({
      /** Whether an open goes over the list (none is open yet), keeping the list's entry if so. */
      openOverList() {
        // The committed location: a second tap before the first open renders must not push again.
        const { pathname, search } = router.latestLocation;
        if (search.open !== undefined) return false;
        const index = router.history.location.state.__TSR_index;
        browserSessionStorage()?.setItem(listEntryKey(pathname), String(index));
        return true;
      },
      /** Goes back to the list's entry when the conversation was opened over it. */
      backToList() {
        const stored = browserSessionStorage()?.getItem(
          listEntryKey(router.latestLocation.pathname),
        );
        const list = stored ? Number(stored) : Number.NaN;
        const index = router.history.location.state.__TSR_index;
        if (!Number.isInteger(list) || index <= list) return false;
        router.history.go(list - index);
        return true;
      },
    }),
    [router],
  );
}

function forgetListEntry(pathname: string) {
  browserSessionStorage()?.removeItem(listEntryKey(pathname));
}
