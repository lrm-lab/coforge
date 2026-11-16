import { useEffect, useState } from "react";

import { useShortcuts } from "#src/hooks/use-shortcuts";
import { isApplePlatform } from "#src/lib/platform";

/** Asks the open search dialog to put the caret back in its box. */
export const SEARCH_FOCUS_EVENT = "coforge:search-focus";

/**
 * Cmd+K on Apple platforms, Ctrl+K elsewhere, from anywhere in the app, even while typing; no
 * other modifier. A held key, input-method composition, or a key another handler already took is
 * left alone.
 */
export function useSearchShortcut(onShortcut: () => void) {
  // At the window, after every handler that might take the key.
  useShortcuts(
    [
      {
        hotkey: "Mod+K",
        take: (event) => {
          if (event.repeat) return false;
          onShortcut();
          return true;
        },
      },
    ],
    { target: "window" },
  );
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
