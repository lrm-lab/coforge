/** The Chat page's conversation list column beside the open conversation, from `lg`. Its width is
 * a per-device preference kept in `localStorage`. */
export const LIST_WIDTH_DEFAULT = 288;
export const LIST_WIDTH_MIN = 200;
export const LIST_WIDTH_MAX = 400;
const KEY_STEP = 16;
const KEY_STEP_LARGE = 64;

export const LIST_WIDTH_KEY = "coforge-conversation-list-width";
export const LIST_WIDTH_PROPERTY = "--conversation-list-width";

/** The column's width class, written out whole for Tailwind: it follows the property the boot
 * script and the resize handle set on `<html>`, so the server markup never depends on the stored
 * width. Tailwind reads the string as written, so it repeats `LIST_WIDTH_PROPERTY`. */
export const LIST_COLUMN_CLASS = "lg:w-(--conversation-list-width,18rem)";

/** The boot half of the rule above, run by `__root.tsx` before paint. Anything that is not a
 * plain number is ignored, a number outside the range is clamped, so the script and
 * `parseListWidth` agree on what a stored width means. */
export const CONVERSATION_LIST_BOOT = `var listWidth=localStorage.getItem("${LIST_WIDTH_KEY}");if(listWidth!==null&&/^\\d+(\\.\\d+)?$/.test(listWidth)){document.documentElement.style.setProperty("${LIST_WIDTH_PROPERTY}",Math.min(${LIST_WIDTH_MAX},Math.max(${LIST_WIDTH_MIN},+listWidth))+"px")}`;

export function clampListWidth(width: number): number {
  return Math.min(LIST_WIDTH_MAX, Math.max(LIST_WIDTH_MIN, width));
}

/** A stored width, clamped; `undefined` for anything that is not a plain number. */
export function parseListWidth(raw: string | null): number | undefined {
  if (raw === null || !/^\d+(\.\d+)?$/.test(raw)) return undefined;
  return clampListWidth(Number(raw));
}

/** What dragging the handle from `startX` to `x` makes of the list: continuous and never outside
 * the range. */
export function dragListWidth(startWidth: number, startX: number, x: number): number {
  return clampListWidth(startWidth + (x - startX));
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
