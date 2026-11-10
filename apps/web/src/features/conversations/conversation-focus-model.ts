import { isImeComposing } from "#src/lib/ime";

/** The panel of the chat page that fills the content card (task #75). */
export type FocusedPanel = "chat" | "thread";

/** Whether this key press leaves focus: a plain Esc nothing took, outside an input method's
 * composition, with no overlay open. The overlay check is lazy, so only Esc pays for it. */
export function shouldExitOnEscape(
  event: Pick<KeyboardEvent, "key" | "defaultPrevented" | "isComposing" | "keyCode">,
  overlayOpen: () => boolean,
): boolean {
  if (event.key !== "Escape" || event.defaultPrevented || isImeComposing(event)) return false;
  return !overlayOpen();
}
