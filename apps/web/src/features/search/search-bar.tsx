import { SearchLg } from "@untitledui/icons";
import { Button as AriaButton } from "react-aria-components";

import { m } from "#src/paraglide/messages";
import { useOpenSearch } from "./search-dialog-context";
import { useSearchShortcutLabel } from "./search-shortcut";

/**
 * The desktop search entry, centred at the top of every page: it looks like a search box but only
 * opens the search dialog, which takes its place.
 */
export function SearchBar() {
  const openSearch = useOpenSearch();
  const shortcut = useSearchShortcutLabel();
  return (
    <AriaButton
      data-search-bar
      onPress={() => openSearch()}
      aria-haspopup="dialog"
      aria-keyshortcuts={shortcut?.keys}
      className="flex h-8 w-full max-w-[30rem] cursor-pointer items-center gap-2 rounded-lg bg-primary px-3 text-sm text-placeholder shadow-xs ring-1 ring-primary outline-focus-ring transition duration-100 ease-linear ring-inset hover:bg-primary_hover focus-visible:outline-2 focus-visible:outline-offset-2"
    >
      <SearchLg aria-hidden="true" className="size-4 stroke-[2.25px] text-fg-quaternary" />
      <span className="flex-1 truncate text-left">{m.search_title()}</span>
      {shortcut ? (
        <kbd
          aria-hidden="true"
          className="rounded px-1 py-px font-body text-xs font-medium text-quaternary ring-1 ring-secondary ring-inset"
        >
          {shortcut.label}
        </kbd>
      ) : null}
    </AriaButton>
  );
}
