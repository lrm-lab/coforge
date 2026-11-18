import { useEffect, useState } from "react";
import { useHotkey } from "@tanstack/react-hotkeys";

import { HOTKEYS, hotkeyAria, hotkeyLabel } from "#src/lib/hotkeys";
import { isApplePlatform } from "#src/lib/platform";

export const SEARCH_FOCUS_EVENT = "coforge:search-focus";

export function useSearchShortcut(onShortcut: () => void) {
  useHotkey(HOTKEYS.search, onShortcut, { requireReset: true });
}

export function useSearchShortcutLabel(): { label: string; keys: string } | undefined {
  const [shortcut, setShortcut] = useState<{ label: string; keys: string }>();
  useEffect(() => {
    const apple = isApplePlatform();
    setShortcut({
      label: hotkeyLabel(HOTKEYS.search, apple),
      keys: hotkeyAria(HOTKEYS.search, apple),
    });
  }, []);
  return shortcut;
}
