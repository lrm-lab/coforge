import { useHotkeys, type HotkeyChord } from "@tanstack/react-hotkeys";

import { TooltipShortcutLabel } from "#src/components/ui/kbd";
import {
  useIsRecordingShortcut,
  useShortcutBindings,
} from "#src/features/shortcuts/shortcut-bindings";
import { useMediaQuery } from "#src/hooks/use-media-query";
import { hasPrimaryModifier } from "#src/lib/hotkeys";
import { isSidebarExpanded, writeSidebarExpanded } from "./sidebar-expanded";

const DESKTOP_QUERY = "(min-width: 64rem)";

export function SidebarToggleTooltip({ label }: { label: string }) {
  const shortcut = useShortcutBindings("sidebar")[0];
  return <TooltipShortcutLabel label={label} shortcut={shortcut} />;
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
