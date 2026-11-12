import { SearchLg } from "@untitledui/icons";
import { Button as AriaButton } from "react-aria-components";

import { RailButton } from "#src/components/layout/sidebar/sidebar-rail";
import { m } from "#src/paraglide/messages";
import { useOpenSearch } from "./search-dialog-context";
import { SEARCH_KEY } from "./search-key-hints";
import { useSearchShortcutLabel } from "./search-shortcut";

/** The search entry that looks like a field, at the top of the sidebar and of a phone's Chat list:
 * flat, its glass on the nav icons' column and its word on their labels' line. It opens the search
 * dialog. */
export function SearchField() {
  const openSearch = useOpenSearch();
  const shortcut = useSearchShortcutLabel();
  return (
    <AriaButton
      data-search-button
      aria-haspopup="dialog"
      aria-keyshortcuts={shortcut?.keys}
      onPress={() => openSearch()}
      className="flex h-9 w-full items-center gap-3 rounded-lg bg-primary px-3 text-sm text-tertiary ring-1 ring-secondary outline-focus-ring transition-colors duration-100 ease-linear ring-inset hover:bg-primary_hover focus-visible:outline-2 focus-visible:outline-offset-2"
    >
      <SearchLg aria-hidden="true" className="size-5 shrink-0 text-fg-quaternary" />
      <span className="min-w-0 flex-1 truncate text-left">{m.search_title()}</span>
      {shortcut && (
        <kbd aria-hidden className={SEARCH_KEY}>
          {shortcut.label}
        </kbd>
      )}
    </AriaButton>
  );
}

/** The same entry in the collapsed rail: the glass, named with its shortcut by the tooltip. */
export function SearchRailButton() {
  const openSearch = useOpenSearch();
  const shortcut = useSearchShortcutLabel();
  return (
    <RailButton
      icon={SearchLg}
      label={m.search_title()}
      tooltip={
        <>
          {m.search_title()}
          {shortcut && <span className="ml-2 text-tooltip-supporting-text">{shortcut.label}</span>}
        </>
      }
      aria-haspopup="dialog"
      aria-keyshortcuts={shortcut?.keys}
      onPress={() => openSearch()}
    />
  );
}
