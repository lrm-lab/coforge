import { useMemo, useRef } from "react";
import { useRouter } from "@tanstack/react-router";

import { useBreakpoint } from "#src/hooks/use-breakpoint";

import type { ListBesideFrom } from "./conversation-list-button";

/**
 * History for a page whose conversation (`open` in its URL) takes the place of its list below
 * `listBesideFrom` (Activity, Search): opening one from the list there pushes an entry, so a
 * phone's back gesture returns to the list, and closing it goes back to the list's entry, past
 * what the conversation pushed (a thread, a profile), rather than stacking a copy of the list.
 * `listParams` are the search params that are the list's own (its view, its query): an entry is
 * the list's only while they match.
 */
export function useListEntryHistory(listBesideFrom: ListBesideFrom, listParams: readonly string[]) {
  const router = useRouter();
  const wide = useBreakpoint(listBesideFrom);
  // Without the Navigation API only this visit's own open is known: the list's entry it pushed over.
  const pushedOver = useRef<number | undefined>(undefined);
  return useMemo(
    () => ({
      /** Whether an open goes over the list (a narrow screen, none open yet): it pushes an entry
       * then, and replaces the current one otherwise. */
      openOverList() {
        // The committed location: a second tap before the first open renders must not push again.
        if (router.latestLocation.search.open !== undefined) return false;
        // An open beside the list replaces the list's entry, so nothing is pushed over it.
        pushedOver.current = wide ? undefined : router.history.location.state.__TSR_index;
        return !wide;
      },
      /** Goes back to the list's entry when it is behind the conversation on this page; false
       * when it is not, so the caller replaces the entry with the list instead. */
      backToList() {
        const index = router.history.location.state.__TSR_index;
        const delta =
          typeof navigation === "undefined"
            ? pushedOver.current !== undefined && pushedOver.current < index
              ? pushedOver.current - index
              : undefined
            : listEntryDelta(listParams);
        if (delta === undefined) return false;
        router.history.go(delta);
        return true;
      },
    }),
    [router, wide, listParams],
  );
}

/**
 * How many entries back the list's entry is: walking back from the current entry over entries of
 * this page and list (the same `listParams`) with a conversation open, the first with none open.
 * Read from the tab's own history (the Navigation API), so it holds after a reload and after
 * leaving the page and coming back with Back, and never reaches past another page or another
 * search or view of the list. Undefined when one of those (or an entry whose address is hidden)
 * comes first.
 */
function listEntryDelta(listParams: readonly string[]): number | undefined {
  const current = navigation.currentEntry;
  if (!current?.url) return undefined;
  const here = new URL(current.url);
  const sameList = (url: URL) =>
    url.pathname === here.pathname &&
    listParams.every((name) => url.searchParams.get(name) === here.searchParams.get(name));
  const entries = navigation.entries();
  for (let index = current.index - 1; index >= 0; index--) {
    const href = entries[index]?.url;
    const url = href ? new URL(href) : undefined;
    if (!url || !sameList(url)) return undefined;
    if (!url.searchParams.has("open")) return index - current.index;
  }
  return undefined;
}
