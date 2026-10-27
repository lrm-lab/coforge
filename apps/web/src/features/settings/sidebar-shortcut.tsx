import { useEffect, useState } from "react";
import { isApplePlatform } from "#src/lib/platform";
import { isSidebarExpanded, writeSidebarExpanded } from "./sidebar-expanded";

/** The width (Tailwind's `lg`) from which the desktop sidebar shows; below it the toggle is hidden. */
const DESKTOP_QUERY = "(min-width: 64rem)";

/**
 * Cmd+B on Apple platforms, Ctrl+B elsewhere; no other modifier. The key that types "b" counts;
 * only on a layout whose keys type no Latin letters does the physical B key stand in. A held key,
 * input-method composition, or a key another handler already took is left alone, and so is any
 * key typed in a rich-text editor, where Cmd/Ctrl+B is bold, a field inside one of its embedded
 * blocks (which are not editable themselves) included.
 */
function isSidebarShortcut(event: KeyboardEvent) {
  if (event.repeat || event.isComposing || event.defaultPrevented) return false;
  const typesLatin = /^[a-z]$/i.test(event.key);
  if (typesLatin ? event.key.toLowerCase() !== "b" : event.code !== "KeyB") return false;
  if (event.altKey || event.shiftKey) return false;
  const target = event.target;
  if (target instanceof HTMLElement && (target.isContentEditable || target.closest(".ProseMirror")))
    return false;
  return isApplePlatform() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

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

/** Cmd/Ctrl+B collapses or expands the desktop sidebar, even while typing in a plain text field. */
export function useSidebarShortcut() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isSidebarShortcut(event) || !window.matchMedia(DESKTOP_QUERY).matches) return;
      event.preventDefault();
      writeSidebarExpanded(!isSidebarExpanded());
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
