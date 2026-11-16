import { useEffect } from "react";

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
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !(event.metaKey || event.ctrlKey) || event.altKey) return;
      if (isTextField(event.target) || document.querySelector(MODAL_OPEN)) return;
      const key = event.key.toLowerCase();
      const acted =
        key === "z" ? (event.shiftKey ? redo() : undo()) : key === "y" && !event.shiftKey && redo();
      if (acted) event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, undo, redo]);
}
