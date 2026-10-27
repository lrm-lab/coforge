import { bootFragment } from "#src/features/settings/boot-fragment";
import { DEVICE_FLAG_HIDDEN } from "#src/features/settings/device-flag";

/** The Chat page's conversation list column beside the open conversation, from `lg`. Its width and
 * whether it is collapsed are per-device preferences kept in `localStorage`. */
export const LIST_WIDTH_DEFAULT = 288;
export const LIST_WIDTH_MIN = 200;
export const LIST_WIDTH_MAX = 400;
/** Dragging this far under the minimum collapses the list instead of stopping at the minimum. */
const LIST_SNAP_DISTANCE = 40;
const KEY_STEP = 16;
const KEY_STEP_LARGE = 64;

export const LIST_WIDTH_KEY = "coforge-conversation-list-width";
/** Stored like the sidebar's flag: hidden when collapsed, anything else is shown. */
export const LIST_VISIBLE_KEY = "coforge-conversation-list-visible";
export const LIST_COLLAPSED_CLASS = "conversation-list-collapsed";
export const LIST_WIDTH_PROPERTY = "--conversation-list-width";

/** The column's classes, written out whole for Tailwind: the width follows the property the boot
 * script and the resize handle set on `<html>`, and the collapsed class hides the column from `lg`
 * (the same shape as `sidebar-collapsed`). The server markup never depends on either. Tailwind
 * reads the strings as written, so they repeat `LIST_WIDTH_PROPERTY` and `LIST_COLLAPSED_CLASS`. */
export const LIST_COLUMN_CLASS =
  "lg:w-(--conversation-list-width,18rem) lg:[.conversation-list-collapsed_&]:hidden";
/** The expand button's counterpart: shown from `lg` only while the class above is set. */
export const LIST_COLLAPSED_SHOW_CLASS = "lg:[.conversation-list-collapsed_&]:inline-flex";

/** The boot half of the rules above, run by `__root.tsx` before paint. Anything that is not a
 * plain number is ignored, a number outside the range is clamped, so the script and
 * `parseListWidth` agree on what a stored width means. */
export const CONVERSATION_LIST_BOOT =
  bootFragment({
    key: LIST_VISIBLE_KEY,
    token: DEVICE_FLAG_HIDDEN,
    className: LIST_COLLAPSED_CLASS,
  }) +
  `var listWidth=localStorage.getItem("${LIST_WIDTH_KEY}");if(listWidth!==null&&/^\\d+(\\.\\d+)?$/.test(listWidth)){document.documentElement.style.setProperty("${LIST_WIDTH_PROPERTY}",Math.min(${LIST_WIDTH_MAX},Math.max(${LIST_WIDTH_MIN},+listWidth))+"px")}`;

export function clampListWidth(width: number): number {
  return Math.min(LIST_WIDTH_MAX, Math.max(LIST_WIDTH_MIN, width));
}

/** A stored width, clamped; `undefined` for anything that is not a plain number. */
export function parseListWidth(raw: string | null): number | undefined {
  if (raw === null || !/^\d+(\.\d+)?$/.test(raw)) return undefined;
  return clampListWidth(Number(raw));
}

/** What dragging the handle from `startX` to `x` makes of the list: continuous, never outside the
 * range, and collapsed once the pointer is further than the snap distance under the minimum. */
export function dragListWidth(
  startWidth: number,
  startX: number,
  x: number,
): { width: number; collapsed: boolean } {
  const raw = startWidth + (x - startX);
  return { width: clampListWidth(raw), collapsed: raw < LIST_WIDTH_MIN - LIST_SNAP_DISTANCE };
}

type KeyboardLike = {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
};

/** The width a key press on the focused handle sets; `undefined` when the key is not one it uses.
 * Combinations with Cmd, Ctrl or Alt stay the browser's (Cmd+Left is Back). */
export function keyListWidth(event: KeyboardLike, width: number): number | undefined {
  if (event.metaKey || event.ctrlKey || event.altKey) return undefined;
  const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
  switch (event.key) {
    case "ArrowRight":
      return clampListWidth(width + step);
    case "ArrowLeft":
      return clampListWidth(width - step);
    case "Home":
      return LIST_WIDTH_MIN;
    case "End":
      return LIST_WIDTH_MAX;
    default:
      return undefined;
  }
}

type ShortcutLike = KeyboardLike & {
  code: string;
  repeat: boolean;
  isComposing: boolean;
  defaultPrevented: boolean;
};

/** Cmd+\ on Apple platforms, Ctrl+\ elsewhere; no Shift or Alt. Matched by the character or, on a
 * layout that types it elsewhere, by the physical key. A held key, input-method composition, or a
 * key another handler already took is left alone. */
export function isListToggleShortcut(event: ShortcutLike, apple: boolean): boolean {
  if (event.repeat || event.isComposing || event.defaultPrevented) return false;
  if (event.code !== "Backslash" && event.key !== "\\") return false;
  if (event.altKey || event.shiftKey) return false;
  return apple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}
