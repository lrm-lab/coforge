import { useSyncExternalStore } from "react";

/** Input types that bring up no on-screen keyboard when focused. */
const NO_KEYBOARD_INPUTS = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

/** Whether focusing `element` brings up the on-screen keyboard: a text field or editable text. */
export function opensKeyboard(
  element: { tagName: string; type?: string; isContentEditable?: boolean } | null | undefined,
): boolean {
  if (!element) return false;
  if (element.isContentEditable) return true;
  if (element.tagName === "TEXTAREA") return true;
  return element.tagName === "INPUT" && !NO_KEYBOARD_INPUTS.has(element.type ?? "text");
}

function subscribe(onChange: () => void) {
  document.addEventListener("focusin", onChange);
  document.addEventListener("focusout", onChange);
  return () => {
    document.removeEventListener("focusin", onChange);
    document.removeEventListener("focusout", onChange);
  };
}

// During `focusout` the active element is already `body`; when focus moves on to another field,
// its `focusin` follows in the same task, before anything is painted.
const read = () => opensKeyboard(document.activeElement as HTMLElement | null);

const ignore = () => () => {};

/**
 * Whether a field that brings up the on-screen keyboard has focus, anywhere on the page. A phone
 * may be showing the keyboard only then. While not `enabled` it reads focus only when its
 * component renders, without following it.
 */
export const useKeyboardFieldFocused = (enabled = true) =>
  useSyncExternalStore(enabled ? subscribe : ignore, read, () => false);
