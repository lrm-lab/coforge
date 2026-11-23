import { useHydrated } from "@tanstack/react-router";
import { useHotkeys, type HotkeyChord } from "@tanstack/react-hotkeys";

import {
  useIsRecordingShortcut,
  useShortcutBindings,
} from "#src/features/shortcuts/shortcut-bindings";
import { hasPrimaryModifier, hotkeyAria } from "#src/lib/hotkeys";
import { isApplePlatform } from "#src/lib/platform";

export const SEARCH_FOCUS_EVENT = "coforge:search-focus";

export function useSearchShortcut(onShortcut: () => void) {
  const bindings = useShortcutBindings("search");
  const recording = useIsRecordingShortcut();
  useHotkeys(
    bindings.map((hotkey) => ({
      hotkey: hotkey as HotkeyChord,
      callback: onShortcut,
      options: {
        enabled: !recording,
        ignoreInputs: !hasPrimaryModifier(hotkey),
        requireReset: true,
      },
    })),
  );
}

export function useSearchShortcutLabel(): { hotkey: string; keys: string } | undefined {
  const bindings = useShortcutBindings("search");
  const primary = bindings[0];
  const hydrated = useHydrated();
  if (!primary || !hydrated) return undefined;
  return {
    hotkey: primary,
    keys: hotkeyAria(primary, isApplePlatform()),
  };
}
