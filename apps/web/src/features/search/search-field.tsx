import { useRef } from "react";
import { SearchLg } from "@untitledui/icons";
import { Button as AriaButton } from "react-aria-components";

import { RailButton } from "#src/components/layout/sidebar/sidebar-rail";
import { captureElementRect } from "#src/lib/shared-element-rect";
import { m } from "#src/paraglide/messages";
import { useOpenSearch } from "./search-dialog-context";
import { preloadSearchDialog } from "./search-dialog-host";
import { SEARCH_KEY } from "./search-key-hints";
import { useSearchShortcutLabel } from "./search-shortcut";

export function SearchField() {
  const openSearch = useOpenSearch();
  const shortcut = useSearchShortcutLabel();
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <AriaButton
      ref={ref}
      data-search-button
      aria-haspopup="dialog"
      aria-keyshortcuts={shortcut?.keys}
      onHoverStart={preloadSearchDialog}
      onFocus={preloadSearchDialog}
      onPress={() => openSearch({ originRect: captureElementRect(ref.current), source: "pointer" })}
      className="flex h-9 w-full items-center gap-3 rounded-lg bg-primary px-3 text-sm text-field-placeholder shadow-xs ring-1 ring-field-border outline-focus-ring transition-colors duration-100 ease-linear ring-inset hover:bg-primary_hover focus-visible:outline-2 focus-visible:outline-offset-2"
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

export function SearchRailButton() {
  const openSearch = useOpenSearch();
  const shortcut = useSearchShortcutLabel();
  const wrapRef = useRef<HTMLSpanElement>(null);
  return (
    <span ref={wrapRef} onPointerEnter={preloadSearchDialog} onFocus={preloadSearchDialog}>
      <RailButton
        icon={SearchLg}
        label={m.search_title()}
        tooltip={
          <>
            {m.search_title()}
            {shortcut && (
              <span className="ml-2 text-tooltip-supporting-text">{shortcut.label}</span>
            )}
          </>
        }
        aria-haspopup="dialog"
        aria-keyshortcuts={shortcut?.keys}
        onPress={() =>
          openSearch({
            originRect: captureElementRect(wrapRef.current?.firstElementChild ?? wrapRef.current),
            source: "pointer",
          })
        }
      />
    </span>
  );
}
