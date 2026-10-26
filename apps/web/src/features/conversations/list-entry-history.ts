import { useMemo } from "react";
import { useRouter } from "@tanstack/react-router";

import { useBreakpoint } from "#src/hooks/use-breakpoint";

import type { ListBesideFrom } from "./conversation-list-button";

/**
 * History for a page whose conversation (`open` in its URL) takes the place of its list below
 * `listBesideFrom` (Activity, Search): opening one from the list there pushes an entry, so a
 * phone's back gesture returns to the list, and closing it goes back to the list's entry, past
 * what the conversation pushed (a thread, a profile), rather than stacking a copy of the list.
 */
export function useListEntryHistory(listBesideFrom: ListBesideFrom) {
  const router = useRouter();
  const wide = useBreakpoint(listBesideFrom);
  return useMemo(
    () => ({
      /** Whether an open goes over the list (a narrow screen, none open yet): it pushes an entry
       * then, and replaces the current one otherwise. */
      openOverList() {
        // The committed location: a second tap before the first open renders must not push again.
        return !wide && router.latestLocation.search.open === undefined;
      },
      /** Goes back to the list's entry when it is behind the conversation on this page; false
       * when it is not, so the caller replaces the entry with the list instead. */
      backToList() {
        const delta = listEntryDelta();
        if (delta === undefined) return false;
        router.history.go(delta);
        return true;
      },
    }),
    [router, wide],
  );
}

/**
 * How many entries back the list's entry is: walking back from the current entry over this page's
 * entries with a conversation open, the first with none open. Read from the tab's own history (the
 * Navigation API), so it holds after a reload and after leaving the page and coming back with
 * Back, and never reaches past another page. Undefined when another page (or an entry whose
 * address is hidden) comes first, or without the Navigation API (before Safari 26.2 and
 * Firefox 147).
 */
function listEntryDelta(): number | undefined {
  const current = typeof navigation === "undefined" ? undefined : navigation.currentEntry;
  if (!current?.url) return undefined;
  const { pathname } = new URL(current.url);
  const entries = navigation.entries();
  for (let index = current.index - 1; index >= 0; index--) {
    const href = entries[index]?.url;
    const url = href ? new URL(href) : undefined;
    if (url?.pathname !== pathname) return undefined;
    if (!url.searchParams.has("open")) return index - current.index;
  }
  return undefined;
}
