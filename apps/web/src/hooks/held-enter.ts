import { useEffect } from "react";

/**
 * Whether a keydown is a held Enter's auto-repeat that would activate something (task #101): a
 * button, a link, a menu item, or a single-line field's form. Only a fresh press activates; held
 * down, Enter's first press opens a dialog and the repeats would otherwise land on the dialog's
 * focused confirm and press it, deleting what the person only meant to ask about. Chrome on macOS
 * clicks a focused button on every repeat (React Aria leaves Enter's default alone on a Mac and on a
 * submit button). A multi-line field and a rich editor keep their repeats: there a held Enter adds
 * lines.
 */
export function isHeldEnter(event: Pick<KeyboardEvent, "key" | "repeat" | "target">) {
  if (event.key !== "Enter" || !event.repeat) return false;
  const target = event.target as { tagName?: string; isContentEditable?: boolean } | null;
  return !(target?.tagName === "TEXTAREA" || target?.isContentEditable);
}

/** Drops held Enter's repeats app-wide (`isHeldEnter`), before any handler or the browser's own
 * activation sees them. Mounted once, in the root document. */
export function HeldEnterGuard() {
  useEffect(() => {
    const drop = (event: KeyboardEvent) => {
      if (!isHeldEnter(event)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", drop, true);
    return () => window.removeEventListener("keydown", drop, true);
  }, []);
  return null;
}
