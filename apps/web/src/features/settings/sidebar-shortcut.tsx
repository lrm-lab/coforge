import { useEffect, useState } from "react";
import { useHotkeys, type HotkeyChord } from "@tanstack/react-hotkeys";

import {
  useIsRecordingShortcut,
  useShortcutBindings,
} from "#src/features/shortcuts/shortcut-bindings";
import { useMediaQuery } from "#src/hooks/use-media-query";
import { hasPrimaryModifier, hotkeyLabel } from "#src/lib/hotkeys";
import { isApplePlatform } from "#src/lib/platform";
import { isSidebarExpanded, writeSidebarExpanded } from "./sidebar-expanded";

const DESKTOP_QUERY = "(min-width: 64rem)";

export function useSidebarShortcutLabel(): string | undefined {
  const bindings = useShortcutBindings("sidebar");
  const primary = bindings[0];
  const [label, setLabel] = useState<string>();
  useEffect(() => {
    setLabel(primary ? hotkeyLabel(primary, isApplePlatform()) : undefined);
  }, [primary]);
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
  const bindings = useShortcutBindings("sidebar");
  const recording = useIsRecordingShortcut();
  useHotkeys(
    bindings.map((hotkey) => ({
      hotkey: hotkey as HotkeyChord,
      callback: (event) => {
        const target = event.target;
        if (
          target instanceof HTMLElement &&
          (target.isContentEditable || target.closest(".ProseMirror"))
        )
          return;
        event.preventDefault();
        writeSidebarExpanded(!isSidebarExpanded());
      },
      options: {
        enabled: desktop && !recording,
        ignoreInputs: !hasPrimaryModifier(hotkey),
        requireReset: true,
        preventDefault: false,
      },
    })),
  );
}
