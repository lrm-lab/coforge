import { useEffect, useState } from "react";
import { useHotkey } from "@tanstack/react-hotkeys";
import { useMediaQuery } from "#src/hooks/use-media-query";
import { HOTKEYS, hotkeyLabel } from "#src/lib/hotkeys";
import { isApplePlatform } from "#src/lib/platform";
import { isSidebarExpanded, writeSidebarExpanded } from "./sidebar-expanded";

const DESKTOP_QUERY = "(min-width: 64rem)";

export function useSidebarShortcutLabel(): string | undefined {
  const [label, setLabel] = useState<string>();
  useEffect(() => setLabel(hotkeyLabel(HOTKEYS.sidebar, isApplePlatform())), []);
  return label;
}

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
    HOTKEYS.sidebar,
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
