import { SearchLg } from "@untitledui/icons";
import { Button as AriaButton } from "react-aria-components";

import { m } from "#src/paraglide/messages";
import { useOpenSearch } from "./search-dialog-context";
import { useSearchShortcutLabel } from "./search-shortcut";

/** The desktop top bar's search entry: looks like a field, opens the search dialog. */
export function SearchField() {
  const openSearch = useOpenSearch();
  const shortcut = useSearchShortcutLabel();
  return (
    <AriaButton
      data-search-button
      aria-haspopup="dialog"
      aria-keyshortcuts={shortcut?.keys}
      onPress={() => openSearch()}
      className="flex h-8 w-full max-w-120 items-center gap-2 rounded-lg bg-primary px-3 text-sm text-placeholder shadow-xs ring-1 ring-secondary outline-focus-ring transition duration-100 ease-linear ring-inset hover:ring-primary focus-visible:outline-2 focus-visible:outline-offset-2"
    >
      <SearchLg aria-hidden="true" className="size-4 shrink-0 text-fg-quaternary" />
      <span className="min-w-0 flex-1 truncate text-left">{m.search_title()}</span>
      {shortcut && (
        <kbd
          aria-hidden
          className="shrink-0 rounded-sm px-1 font-body text-xs text-quaternary ring-1 ring-secondary ring-inset"
        >
          {shortcut.label}
        </kbd>
      )}
    </AriaButton>
  );
}
