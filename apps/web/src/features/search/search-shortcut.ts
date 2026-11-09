import { useEffect, useEffectEvent } from "react";

import { isApplePlatform } from "#src/lib/platform";

/** Asks the open search dialog to put the caret back in its box. */
export const SEARCH_FOCUS_EVENT = "coforge:search-focus";

/**
 * Cmd+K on Apple platforms, Ctrl+K elsewhere; no other modifier. The key that types "k" counts;
 * only on a layout whose keys type no Latin letters does the physical K key stand in, so Dvorak's
 * Cmd+T or Colemak's Cmd+E are never taken. A held key, input-method composition, or a key
 * another handler already took is left alone.
 */
function isSearchShortcut(event: KeyboardEvent) {
  if (event.repeat || event.isComposing || event.defaultPrevented) return false;
  const typesLatin = /^[a-z]$/i.test(event.key);
  if (typesLatin ? event.key.toLowerCase() !== "k" : event.code !== "KeyK") return false;
  if (event.altKey || event.shiftKey) return false;
  return isApplePlatform() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/** Cmd/Ctrl+K from anywhere in the app, even while typing. */
export function useSearchShortcut(onShortcut: () => void) {
  const fire = useEffectEvent(onShortcut);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isSearchShortcut(event)) return;
      event.preventDefault();
      fire();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
