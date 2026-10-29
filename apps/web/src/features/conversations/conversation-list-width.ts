import { m } from "#src/paraglide/messages";

/** A list column whose width is a per-device preference kept in `localStorage`, set on `<html>` as
 * a CSS property the column's width follows (by the boot script before paint, then by its resize
 * handle). The two columns keep separate widths, as Raft keeps its sidebar and list widths. */
export type ListColumn = {
  key: string;
  property: string;
  defaultWidth: number;
  min: number;
  max: number;
  /** The resize handle's accessible name. */
  label: () => string;
};

/** The Chat page's conversation list beside the open conversation, from `lg`. */
export const CONVERSATION_LIST_COLUMN: ListColumn = {
  key: "coforge-conversation-list-width",
  property: "--conversation-list-width",
  defaultWidth: 288,
  min: 200,
  max: 400,
  label: m.conversation_list_resize,
};

/** The list beside a conversation pane on Activity and Search (`w-list-column`), Raft's list
 * column: one width for both pages. */
export const LIST_COLUMN: ListColumn = {
  key: "coforge-list-column-width",
  property: "--list-column-width",
  defaultWidth: 380,
  min: 240,
  max: 640,
  label: m.list_column_resize,
};

const KEY_STEP = 16;
const KEY_STEP_LARGE = 64;

/** The Chat list's width class, written out whole for Tailwind: it follows the property the boot
 * script and the resize handle set on `<html>`, so the server markup never depends on the stored
 * width. Tailwind reads the string as written, so it repeats `CONVERSATION_LIST_COLUMN.property`.
 * `w-list-column` in `styles.css` does the same for `LIST_COLUMN`. */
export const LIST_COLUMN_CLASS = "lg:w-(--conversation-list-width,18rem)";

const PLAIN_NUMBER = /^\d+(\.\d+)?$/;

/** The boot half of the rule above, run by `__root.tsx` before paint. Anything that is not a
 * plain number is ignored, a number outside the range is clamped, so the script and
 * `parseListWidth` agree on what a stored width means. */
function bootScript({ key, property, min, max }: ListColumn): string {
  return `var listWidth=localStorage.getItem("${key}");if(listWidth!==null&&${PLAIN_NUMBER}.test(listWidth)){document.documentElement.style.setProperty("${property}",Math.min(${max},Math.max(${min},+listWidth))+"px")}`;
}

export const CONVERSATION_LIST_BOOT =
  bootScript(CONVERSATION_LIST_COLUMN) + bootScript(LIST_COLUMN);

export function clampListWidth(column: ListColumn, width: number): number {
  return Math.min(column.max, Math.max(column.min, width));
}

/** A stored width, clamped; `undefined` for anything that is not a plain number. */
export function parseListWidth(column: ListColumn, raw: string | null): number | undefined {
  if (raw === null || !PLAIN_NUMBER.test(raw)) return undefined;
  return clampListWidth(column, Number(raw));
}

/** What dragging the handle from `startX` to `x` makes of the list: continuous and never outside
 * the range. */
export function dragListWidth(
  column: ListColumn,
  startWidth: number,
  startX: number,
  x: number,
): number {
  return clampListWidth(column, startWidth + (x - startX));
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
export function keyListWidth(
  column: ListColumn,
  event: KeyboardLike,
  width: number,
): number | undefined {
  if (event.metaKey || event.ctrlKey || event.altKey) return undefined;
  const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
  switch (event.key) {
    case "ArrowRight":
      return clampListWidth(column, width + step);
    case "ArrowLeft":
      return clampListWidth(column, width - step);
    case "Home":
      return column.min;
    case "End":
      return column.max;
    default:
      return undefined;
  }
}
