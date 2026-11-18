import { useEffect, useState } from "react";
import { useHotkey } from "@tanstack/react-hotkeys";

import { isApplePlatform } from "#src/lib/platform";

export const SEARCH_FOCUS_EVENT = "coforge:search-focus";

export function useSearchShortcut(onShortcut: () => void) {
  useHotkey("Mod+K", onShortcut, { requireReset: true });
}

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
