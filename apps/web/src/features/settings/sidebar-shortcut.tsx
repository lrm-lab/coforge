import { useEffect, useState } from "react";
import { useHotkey } from "@tanstack/react-hotkeys";
import { useMediaQuery } from "#src/hooks/use-media-query";
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

export function useSidebarShortcut() {
  const desktop = useMediaQuery(DESKTOP_QUERY, false);
  useHotkey(
    "Mod+B",
    (event) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || target.closest(".ProseMirror"))
      )
        return;
      event.preventDefault();
      writeSidebarExpanded(!isSidebarExpanded());
    },
    { enabled: desktop, requireReset: true, preventDefault: false },
  );
}
