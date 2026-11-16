import { type RegisterableHotkey, useHotkeys } from "@tanstack/react-hotkeys";

import { isApplePlatform } from "#src/lib/platform";

export type Shortcut = {
  hotkey: RegisterableHotkey;
  /** Acts on the key and says whether it took it; a key it declines keeps its default. */
  take: (event: KeyboardEvent) => boolean;
};

/**
 * Keyboard shortcuts through TanStack Hotkeys, keeping the app's contract for a shared key: a key
 * another handler already took (`defaultPrevented`) or an input method is composing is left
 * alone, and a key is prevented only when a shortcut takes it, so one that declines (bold in an
 * editor, a control owning its arrows) still works. The framework itself prevents and stops
 * every key it matches, before asking, and never looks at either. `Mod` follows
 * `isApplePlatform`, as the shortcuts' tooltips do. Listens at the document unless `target` says
 * otherwise; text fields are left alone for keys without Ctrl or Cmd unless `ignoreInputs` is
 * false.
 */
export function useShortcuts(
  shortcuts: readonly Shortcut[],
  options: { enabled?: boolean; ignoreInputs?: boolean; target?: "window" } = {},
) {
  const { target, ...rest } = options;
  useHotkeys(
    shortcuts.map(({ hotkey, take }) => ({
      hotkey,
      callback: (event: KeyboardEvent) => {
        if (event.defaultPrevented || event.isComposing) return;
        if (take(event)) event.preventDefault();
      },
    })),
    {
      ...rest,
      // Resolved at render, where the server has no window; the registration waits for the client.
      target: target === "window" && typeof window !== "undefined" ? window : undefined,
      platform: isApplePlatform() ? "mac" : "windows",
      preventDefault: false,
      stopPropagation: false,
      conflictBehavior: "allow",
    },
  );
}
