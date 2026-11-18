import { isImeComposing } from "#src/lib/ime";

export type FocusedPanel = "chat" | "thread";

export function shouldExitOnEscape(
  event: Pick<KeyboardEvent, "key" | "defaultPrevented" | "isComposing" | "keyCode">,
  overlayOpen: () => boolean,
): boolean {
  if (event.key !== "Escape" || event.defaultPrevented || isImeComposing(event)) return false;
  return !overlayOpen();
}
