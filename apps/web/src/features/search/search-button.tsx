import { SearchLg } from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { useCloseMobileDrawer } from "#src/components/layout/sidebar/mobile-header";
import { m } from "#src/paraglide/messages";
import { useOpenSearch } from "./search-dialog-context";
import { useSearchShortcutLabel } from "./search-shortcut";

/** The phone drawer's search entry, beside the Workspace in its top row: closes the drawer and
 * opens the search dialog over the page. The desktop entry is the top bar's `SearchField`. */
export function SearchButton() {
  const openSearch = useOpenSearch();
  const closeDrawer = useCloseMobileDrawer();
  const shortcut = useSearchShortcutLabel();
  return (
    <ButtonUtility
      icon={SearchLg}
      size="sm"
      color="tertiary"
      tooltip={m.search_title()}
      tooltipShortcut={shortcut?.label}
      aria-haspopup="dialog"
      aria-keyshortcuts={shortcut?.keys}
      onClick={() => {
        closeDrawer();
        openSearch();
      }}
    />
  );
}
