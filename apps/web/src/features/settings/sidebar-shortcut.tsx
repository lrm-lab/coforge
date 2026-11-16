import { useEffect, useState } from "react";
import { useShortcuts } from "#src/hooks/use-shortcuts";
import { isApplePlatform } from "#src/lib/platform";
import { isSidebarExpanded, writeSidebarExpanded } from "./sidebar-expanded";

/** The width (Tailwind's `lg`) from which the desktop sidebar shows; below it the toggle is hidden. */
const DESKTOP_QUERY = "(min-width: 64rem)";

/** The shortcut as the toggle's tooltip shows it; `undefined` until the platform is known. */
export function useSidebarShortcutLabel(): string | undefined {
  // Read after mount: the server render cannot know the viewer's platform.
  const [label, setLabel] = useState<string>();
  useEffect(() => setLabel(isApplePlatform() ? "⌘B" : "Ctrl+B"), []);
  return label;
}

/** The toggle's tooltip: its name, then the shortcut in the tooltip's supporting color. */
export function SidebarToggleTooltip({ label }: { label: string }) {
  const shortcut = useSidebarShortcutLabel();
  return (
    <>
      {label}
      {shortcut && <span className="ml-2 text-tooltip-supporting-text">{shortcut}</span>}
    </>
  );
}

/**
 * Cmd+B on Apple platforms, Ctrl+B elsewhere, no other modifier, collapses or expands the desktop
 * sidebar, even while typing in a plain text field. A held key, input-method composition, or a key
 * another handler already took is left alone, and so is any key typed in a rich-text editor, where
 * Cmd/Ctrl+B is bold, a field inside one of its embedded blocks (which are not editable
 * themselves) included.
 */
export function useSidebarShortcut() {
  // At the window, after every handler that might take the key.
  useShortcuts(
    [
      {
        hotkey: "Mod+B",
        take: (event) => {
          const target = event.target;
          if (event.repeat || !window.matchMedia(DESKTOP_QUERY).matches) return false;
          if (
            target instanceof HTMLElement &&
            (target.isContentEditable || target.closest(".ProseMirror"))
          )
            return false;
          writeSidebarExpanded(!isSidebarExpanded());
          return true;
        },
      },
    ],
    { target: "window" },
  );
}
