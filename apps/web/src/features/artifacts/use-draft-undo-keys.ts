import { useEffect } from "react";

import {
  isRecordingShortcut,
  readShortcutBindings,
} from "#src/features/shortcuts/shortcut-bindings";
import { hotkeyMatchesEvent } from "#src/lib/hotkeys";
import { isApplePlatform } from "#src/lib/platform";

const MODAL_OPEN = '[role="dialog"]:not([data-comment-popover]), [role="alertdialog"]';

const isTextField = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

export function useDraftUndoKeys({
  enabled,
  undo,
  redo,
}: {
  enabled: boolean;
  undo: () => boolean;
  redo: () => boolean;
}) {
  useEffect(() => {
    if (!enabled) return;
    const apple = isApplePlatform();
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isRecordingShortcut()) return;
      if (isTextField(event.target) || document.querySelector(MODAL_OPEN)) return;
      const isRedo = readShortcutBindings("draftRedo").some((hotkey) =>
        hotkeyMatchesEvent(hotkey, event, apple),
      );
      const isUndo =
        !isRedo &&
        readShortcutBindings("draftUndo").some((hotkey) =>
          hotkeyMatchesEvent(hotkey, event, apple),
        );
      const acted = isRedo ? redo() : isUndo ? undo() : false;
      if (acted) event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, undo, redo]);
}
