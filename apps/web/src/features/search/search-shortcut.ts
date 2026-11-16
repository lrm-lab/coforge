import { useEffect, useState } from "react";
import { useHotkey } from "@tanstack/react-hotkeys";

import { isApplePlatform } from "#src/lib/platform";

/** Asks the open search dialog to put the caret back in its box. */
export const SEARCH_FOCUS_EVENT = "coforge:search-focus";

export function useSearchShortcut(onShortcut: () => void) {
  useHotkey("Mod+K", onShortcut, { requireReset: true });
}

/** The shortcut as the viewer's keyboard names it, and as `aria-keyshortcuts` names it; unknown
 * until mounted, as the server can't tell. */
export function useSearchShortcutLabel(): { label: string; keys: string } | undefined {
  const [shortcut, setShortcut] = useState<{ label: string; keys: string }>();
  useEffect(
    () =>
      setShortcut(
        isApplePlatform()
          ? { label: "⌘K", keys: "Meta+K" }
          : { label: "Ctrl+K", keys: "Control+K" },
      ),
    [],
  );
  return shortcut;
}
