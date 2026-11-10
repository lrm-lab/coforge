import { SearchLg } from "@untitledui/icons";
import { Button as AriaButton } from "react-aria-components";

import { m } from "#src/paraglide/messages";
import { useOpenSearch } from "./search-dialog-context";
import { SEARCH_KEY } from "./search-key-hints";
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
      className="flex h-9 w-full max-w-120 items-center gap-2 rounded-lg bg-primary px-3 text-sm text-tertiary shadow-xs ring-1 ring-primary outline-focus-ring transition duration-100 ease-linear ring-inset hover:bg-primary_hover focus-visible:outline-2 focus-visible:outline-offset-2"
    >
      <SearchLg aria-hidden="true" className="size-4 shrink-0 text-fg-tertiary" />
      <span className="min-w-0 flex-1 truncate text-left">{m.search_title()}</span>
      {shortcut && (
        <kbd aria-hidden className={SEARCH_KEY}>
          {shortcut.label}
        </kbd>
      )}
    </AriaButton>
  );
}
