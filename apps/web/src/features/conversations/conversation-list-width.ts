import { m } from "#src/paraglide/messages";

export type ListColumn = {
  key: string;
  property: string;
  defaultWidth: number;
  min: number;
  max: number;
  label: () => string;
  edge?: "left" | "right";
};

export const SIDEBAR_COLUMN: ListColumn = {
  key: "coforge-sidebar-width",
  property: "--sidebar-width",
  defaultWidth: 13.75,
  min: 13.75,
  max: 20,
  label: m.navigation_resize_sidebar,
};

export const CONVERSATION_LIST_COLUMN: ListColumn = {
  key: "coforge-conversation-list-width",
  property: "--conversation-list-width",
  defaultWidth: 18,
  min: 12.5,
  max: 25,
  label: m.conversation_list_resize,
};

export const LIST_COLUMN: ListColumn = {
  key: "coforge-list-column-width",
  property: "--list-column-width",
  defaultWidth: 23.75,
  min: 18,
  max: 40,
  label: m.list_column_resize,
};

export const ATTACHMENT_COMMENTS_COLUMN: ListColumn = {
  key: "coforge-attachment-comments-width",
  property: "--attachment-comments-width",
  defaultWidth: 20,
  min: 17.5,
  max: 35,
  label: m.attachment_comments_resize,
  edge: "left",
};

const KEY_STEP = 1;
const KEY_STEP_LARGE = 4;
const LEGACY_PX_THRESHOLD = 80;
const LEGACY_BASE_FONT_PX = 16;

export const LIST_COLUMN_CLASS = "lg:w-[min(var(--conversation-list-width,18rem),40%)]";

const PLAIN_NUMBER = /^\d+(\.\d+)?$/;

function bootScript({ key, property, min, max }: ListColumn): string {
  return `var listWidth=localStorage.getItem("${key}");if(listWidth!==null&&${PLAIN_NUMBER}.test(listWidth)){var listRem=+listWidth>${LEGACY_PX_THRESHOLD}?+listWidth/${LEGACY_BASE_FONT_PX}:+listWidth;document.documentElement.style.setProperty("${property}",Math.min(${max},Math.max(${min},listRem))+"rem")}`;
}

export const CONVERSATION_LIST_BOOT =
  bootScript(SIDEBAR_COLUMN) +
  bootScript(CONVERSATION_LIST_COLUMN) +
  bootScript(LIST_COLUMN) +
  bootScript(ATTACHMENT_COMMENTS_COLUMN);

export function clampListWidth(column: ListColumn, width: number): number {
  return Math.min(column.max, Math.max(column.min, width));
}

export function parseListWidth(column: ListColumn, raw: string | null): number | undefined {
  if (raw === null || !PLAIN_NUMBER.test(raw)) return undefined;
  const parsed = Number(raw);
  const rem = parsed > LEGACY_PX_THRESHOLD ? parsed / LEGACY_BASE_FONT_PX : parsed;
  return clampListWidth(column, rem);
}

function edgeDirection(column: ListColumn, rtl = false): 1 | -1 {
  const ltrSign = column.edge === "left" ? -1 : 1;
  return rtl ? (-ltrSign as 1 | -1) : ltrSign;
}

export function dragListWidth(
  column: ListColumn,
  startWidth: number,
  startX: number,
  x: number,
  rtl = false,
): number {
  const moved = (x - startX) * edgeDirection(column, rtl);
  return clampListWidth(column, startWidth + moved);
}

type KeyboardLike = {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
};

export function keyListWidth(
  column: ListColumn,
  event: KeyboardLike,
  width: number,
  rtl = false,
): number | undefined {
  if (event.metaKey || event.ctrlKey || event.altKey) return undefined;
  const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
  const toward = edgeDirection(column, rtl);
  switch (event.key) {
    case "ArrowRight":
      return clampListWidth(column, width + step * toward);
    case "ArrowLeft":
      return clampListWidth(column, width - step * toward);
    case "Home":
      return column.min;
    case "End":
      return column.max;
    default:
      return undefined;
  }
}
